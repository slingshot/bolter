/**
 * IndexedDB persistence for multipart upload state.
 * Allows uploads to survive page reloads.
 */

// Version 2: encrypted parts are cut on ECE record boundaries. Pre-v2 encrypted
// state with completed parts was cut mid-record and cannot be resumed safely.
// Version 3: state carries a content fingerprint of the file being uploaded so a
// resume cannot splice a different file's tail onto the uploaded prefix.
export const UPLOAD_STATE_VERSION = 3;

// The version at which encrypted parts started being cut on ECE record
// boundaries. Pinned separately from UPLOAD_STATE_VERSION so later schema bumps
// don't retroactively poison correctly-aligned state.
const ECE_ALIGNED_STATE_VERSION = 2;

export interface PersistedUpload {
    version?: number; // Schema version (missing = 1, pre record-aligned cuts)
    fileId: string; // Bolter file ID
    uploadId: string; // S3 multipart upload ID
    ownerToken: string; // For completion/abort
    fileName: string; // To match against re-selected file
    fileSize: number; // Raw (pre-encryption) file size for matching
    fileLastModified: number; // To verify same file
    // Content fingerprint of the file (see computeContentFingerprint). (name,
    // size, mtime) is not an identity: a different file with the same tuple
    // would be spliced tail-onto-prefix and, for encrypted uploads, decrypt
    // cleanly into a corrupt hybrid.
    contentFingerprint?: string;
    encrypted: boolean;
    partSize: number; // Encrypted part size used by S3
    plaintextPartSize: number; // Plaintext bytes per part (for resume offset)
    completedParts: Array<{ PartNumber: number; ETag: string }>;
    totalParts: number;
    encryptionSalt?: string; // Base64 salt for key derivation (reserved)
    secretKeyB64?: string; // Base64 secret key (to reconstruct Keychain)
    timeLimit: number;
    downloadLimit: number;
    createdAt: number; // Timestamp for cleanup
}

// Bytes read per sampled window when fingerprinting file content.
export const FINGERPRINT_WINDOW_BYTES = 1024 * 1024;
// Number of windows sampled across the file.
export const FINGERPRINT_WINDOWS = 4;

/**
 * Content fingerprint used to verify that a file offered for resume really is
 * the file whose prefix was already uploaded.
 *
 * Hashing the whole uploaded prefix would mean re-reading up to hundreds of
 * gigabytes (and WebCrypto has no incremental digest), which defeats the point
 * of resuming. Instead this hashes the file size plus a bounded, deterministic
 * set of sampled windows spread across the file — always including the very
 * start, so a file whose content differs from the uploaded prefix is rejected.
 */
export async function computeContentFingerprint(blob: Blob): Promise<string> {
    const size = blob.size;
    const windows: Array<[number, number]> = [];

    if (size <= FINGERPRINT_WINDOW_BYTES * FINGERPRINT_WINDOWS) {
        windows.push([0, size]);
    } else {
        const stride = Math.floor(
            (size - FINGERPRINT_WINDOW_BYTES) / Math.max(1, FINGERPRINT_WINDOWS - 1),
        );
        for (let i = 0; i < FINGERPRINT_WINDOWS; i++) {
            const start =
                i === FINGERPRINT_WINDOWS - 1 ? size - FINGERPRINT_WINDOW_BYTES : i * stride;
            windows.push([start, start + FINGERPRINT_WINDOW_BYTES]);
        }
    }

    // The header binds the digest to the size and the exact sampled ranges, so
    // two different sampling layouts can never produce the same fingerprint.
    const header = new TextEncoder().encode(
        `bolter-fp/1|${size}|${windows.map(([s, e]) => `${s}-${e}`).join(',')}\n`,
    );

    const chunks: Uint8Array[] = [header];
    for (const [start, end] of windows) {
        chunks.push(new Uint8Array(await blob.slice(start, end).arrayBuffer()));
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
    }

    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * File IDs that must never be resumed, marked synchronously in memory.
 *
 * IndexedDB writes are independent transactions with no ordering guarantees, so
 * a best-effort `deleteUploadState()` can lose a race with an in-flight
 * `updateCompletedPart()` and leave poisoned state behind. Marking here first
 * suppresses every later write regardless of whether the delete lands.
 */
const nonResumableUploads = new Set<string>();

export function isUploadNonResumable(fileId: string): boolean {
    return nonResumableUploads.has(fileId);
}

/**
 * Synchronously mark an upload as non-resumable, then best-effort delete its
 * persisted state. Callers may ignore the returned promise: the in-memory mark
 * already guarantees no further writes and no resume offer for this file ID.
 */
export function discardUploadState(fileId: string): Promise<void> {
    nonResumableUploads.add(fileId);
    return deleteUploadState(fileId).catch(() => {
        // Intentionally ignored — the in-memory mark is the real guarantee
    });
}

const DB_NAME = 'bolter-uploads';
const DB_VERSION = 1;
const STORE_NAME = 'uploads';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'fileId' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// State that can never be safely resumed:
//  - Encrypted pre-v2 state with completed parts was cut mid-ECE-record, so a
//    resume would duplicate a record fragment and produce an undecryptable file.
//  - State with completed parts but no content fingerprint cannot prove the
//    re-selected file matches the uploaded prefix, so resuming it risks
//    splicing a different file's tail onto that prefix.
//  - State marked non-resumable in this session (e.g. a merged final part broke
//    the fixed-part-size offset math a resume relies on).
function isPoisonedUploadState(state: PersistedUpload): boolean {
    if (nonResumableUploads.has(state.fileId)) {
        return true;
    }
    if (state.completedParts.length >= 1) {
        if (state.encrypted && (state.version ?? 1) < ECE_ALIGNED_STATE_VERSION) {
            return true;
        }
        if (!state.contentFingerprint) {
            return true;
        }
    }
    return false;
}

export async function saveUploadState(state: PersistedUpload): Promise<void> {
    if (nonResumableUploads.has(state.fileId)) {
        return;
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({
            ...state,
            version: state.version ?? UPLOAD_STATE_VERSION,
        });
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}

export async function updateCompletedPart(
    fileId: string,
    part: { PartNumber: number; ETag: string },
): Promise<void> {
    // Suppressed for uploads marked non-resumable — otherwise this write can
    // land after a best-effort deleteUploadState and resurrect poisoned state.
    if (nonResumableUploads.has(fileId)) {
        return;
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(fileId);
        getReq.onsuccess = () => {
            const state = getReq.result as PersistedUpload | undefined;
            if (state) {
                // Avoid duplicates
                if (!state.completedParts.some((p) => p.PartNumber === part.PartNumber)) {
                    state.completedParts.push(part);
                    store.put(state);
                }
            }
        };
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}

export async function getResumableUpload(
    fileName: string,
    fileSize: number,
    lastModified: number,
): Promise<PersistedUpload | null> {
    const db = await openDB();
    const { found, poisonedIds } = await new Promise<{
        found: PersistedUpload | null;
        poisonedIds: string[];
    }>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();
        let match: PersistedUpload | null = null;
        const poisoned: string[] = [];

        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                const state = cursor.value as PersistedUpload;
                if (isPoisonedUploadState(state)) {
                    poisoned.push(state.fileId);
                } else if (
                    state.fileName === fileName &&
                    state.fileSize === fileSize &&
                    state.fileLastModified === lastModified
                ) {
                    // Keep the most recent match (by createdAt)
                    if (!match || state.createdAt > match.createdAt) {
                        match = state;
                    }
                }
                cursor.continue();
            }
        };
        tx.oncomplete = () => {
            db.close();
            resolve({ found: match, poisonedIds: poisoned });
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });

    for (const fileId of poisonedIds) {
        await deleteUploadState(fileId);
    }
    return found;
}

export async function getAnyResumableUpload(): Promise<PersistedUpload | null> {
    const db = await openDB();
    const { found, poisonedIds } = await new Promise<{
        found: PersistedUpload | null;
        poisonedIds: string[];
    }>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();
        let match: PersistedUpload | null = null;
        const poisoned: string[] = [];

        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                const state = cursor.value as PersistedUpload;
                if (isPoisonedUploadState(state)) {
                    poisoned.push(state.fileId);
                    cursor.continue();
                    return;
                }
                if (!match) {
                    match = state; // Return first resumable entry
                }
                cursor.continue();
            }
        };
        tx.oncomplete = () => {
            db.close();
            resolve({ found: match, poisonedIds: poisoned });
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });

    for (const fileId of poisonedIds) {
        await deleteUploadState(fileId);
    }
    return found;
}

export async function deleteUploadState(fileId: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(fileId);
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}

export async function cleanupExpiredUploads(): Promise<void> {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - SEVEN_DAYS;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();

        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                const state = cursor.value as PersistedUpload;
                if (state.createdAt < cutoff) {
                    cursor.delete();
                }
                cursor.continue();
            }
        };
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}
