/**
 * JSON file persistence for multipart upload resume state.
 * Stores upload state at ~/.bolter/uploads/<fileId>.json so interrupted
 * uploads can be resumed across process restarts.
 */

import { mkdir, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UPLOADS_DIR = join(homedir(), '.bolter', 'uploads');

/** Maximum age (in ms) before a persisted upload state is considered expired. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PersistedUpload {
    fileId: string;
    uploadId: string;
    ownerToken: string;
    fileName: string;
    fileSize: number;
    fileMtime: number; // fs stat mtime for identity verification
    encrypted: boolean;
    partSize: number;
    plaintextPartSize: number;
    completedParts: { PartNumber: number; ETag: string }[];
    totalParts: number;
    secretKeyB64?: string; // to reconstruct Keychain on resume
    timeLimit: number;
    downloadLimit: number;
    createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure the uploads directory exists. */
async function ensureDir(): Promise<void> {
    await mkdir(UPLOADS_DIR, { recursive: true });
}

/** Build the path for a given fileId's state file. */
function statePath(fileId: string): string {
    return join(UPLOADS_DIR, `${fileId}.json`);
}

/**
 * Per-file write queue to prevent concurrent read-modify-write races.
 * Concurrent `updatePart` calls are serialized per fileId.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueue(fileId: string, fn: () => Promise<void>): Promise<void> {
    const prev = writeQueues.get(fileId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run even if previous failed
    writeQueues.set(fileId, next);
    // Cleanup once settled to avoid unbounded growth
    next.finally(() => {
        if (writeQueues.get(fileId) === next) {
            writeQueues.delete(fileId);
        }
    });
    return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist upload state to disk.
 */
export async function save(state: PersistedUpload): Promise<void> {
    await ensureDir();
    await Bun.write(statePath(state.fileId), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Load upload state for a given fileId.
 * Returns null if the state file does not exist or is unreadable.
 */
export async function load(fileId: string): Promise<PersistedUpload | null> {
    try {
        const file = Bun.file(statePath(fileId));
        if (await file.exists()) {
            return (await file.json()) as PersistedUpload;
        }
    } catch {
        // Corrupt or unreadable — treat as missing
    }
    return null;
}

/**
 * Record a completed part for a given upload.
 * De-duplicates by PartNumber — if a part with the same number already
 * exists it is replaced with the new ETag.
 * Writes are serialized per fileId to prevent concurrent race conditions.
 */
export function updatePart(
    fileId: string,
    part: { PartNumber: number; ETag: string },
): Promise<void> {
    return enqueue(fileId, async () => {
        const state = await load(fileId);
        if (!state) {
            return;
        }

        // Remove any existing entry for this part number
        state.completedParts = state.completedParts.filter((p) => p.PartNumber !== part.PartNumber);
        state.completedParts.push(part);

        // Keep sorted for deterministic output
        state.completedParts.sort((a, b) => a.PartNumber - b.PartNumber);

        await save(state);
    });
}

/**
 * Remove persisted state for a completed or aborted upload.
 */
export async function remove(fileId: string): Promise<void> {
    try {
        await unlink(statePath(fileId));
    } catch {
        // File may not exist — that's fine
    }
}

/**
 * Scan all persisted uploads and find one that matches the given file
 * identity (name + size + mtime). If multiple matches exist, the most
 * recently created state is returned.
 */
export async function findResumable(
    fileName: string,
    fileSize: number,
    fileMtime: number,
): Promise<PersistedUpload | null> {
    try {
        await ensureDir();
        const entries = await readdir(UPLOADS_DIR);
        let best: PersistedUpload | null = null;

        for (const entry of entries) {
            if (!entry.endsWith('.json')) {
                continue;
            }

            try {
                const file = Bun.file(join(UPLOADS_DIR, entry));
                const state = (await file.json()) as PersistedUpload;

                if (
                    state.fileName === fileName &&
                    state.fileSize === fileSize &&
                    state.fileMtime === fileMtime
                ) {
                    if (!best || state.createdAt > best.createdAt) {
                        best = state;
                    }
                }
            } catch {
                // Skip corrupt entries
            }
        }

        return best;
    } catch {
        return null;
    }
}

/**
 * Delete state files older than 7 days.
 */
export async function cleanupExpired(): Promise<void> {
    try {
        await ensureDir();
        const entries = await readdir(UPLOADS_DIR);
        const now = Date.now();

        for (const entry of entries) {
            if (!entry.endsWith('.json')) {
                continue;
            }

            try {
                const filePath = join(UPLOADS_DIR, entry);
                const file = Bun.file(filePath);
                const state = (await file.json()) as PersistedUpload;

                if (now - state.createdAt > MAX_AGE_MS) {
                    await unlink(filePath);
                }
            } catch {
                // Skip unreadable files — they'll be cleaned up eventually
            }
        }
    } catch {
        // If the directory doesn't exist yet, nothing to clean
    }
}
