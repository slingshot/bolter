/**
 * IndexedDB persistence for multipart upload state.
 * Allows uploads to survive page reloads.
 */

export interface PersistedUpload {
    fileId: string; // Bolter file ID
    uploadId: string; // S3 multipart upload ID
    ownerToken: string; // For completion/abort
    fileName: string; // To match against re-selected file
    fileSize: number; // Raw (pre-encryption) file size for matching
    fileLastModified: number; // To verify same file
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

export async function saveUploadState(state: PersistedUpload): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(state);
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
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();
        let found: PersistedUpload | null = null;

        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                const state = cursor.value as PersistedUpload;
                if (
                    state.fileName === fileName &&
                    state.fileSize === fileSize &&
                    state.fileLastModified === lastModified
                ) {
                    // Keep the most recent match (by createdAt)
                    if (!found || state.createdAt > found.createdAt) {
                        found = state;
                    }
                }
                cursor.continue();
            }
        };
        tx.oncomplete = () => {
            db.close();
            resolve(found);
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}

export async function getAnyResumableUpload(): Promise<PersistedUpload | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();

        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                resolve(cursor.value as PersistedUpload);
                return; // Return first found
            }
            resolve(null);
        };
        tx.oncomplete = () => {
            db.close();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
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
