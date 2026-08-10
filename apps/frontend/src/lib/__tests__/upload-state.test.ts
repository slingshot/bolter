import { beforeEach, describe, expect, it } from 'vitest';
import type { PersistedUpload } from '@/lib/upload-state';

// Helper to create a valid PersistedUpload object with overrides.
// A contentFingerprint is present by default: state that has completed parts
// but no fingerprint cannot prove the re-selected file matches the uploaded
// prefix, so it is deliberately treated as unresumable.
function makeUpload(overrides: Partial<PersistedUpload> = {}): PersistedUpload {
    return {
        fileId: `file-${Math.random().toString(36).slice(2)}`,
        uploadId: `upload-${Math.random().toString(36).slice(2)}`,
        ownerToken: 'owner-token-123',
        fileName: 'test-file.bin',
        fileSize: 1_000_000,
        fileLastModified: 1700000000000,
        contentFingerprint: 'fingerprint-of-test-file',
        encrypted: false,
        partSize: 10_000_000,
        plaintextPartSize: 10_000_000,
        completedParts: [],
        totalParts: 10,
        timeLimit: 86400,
        downloadLimit: 1,
        createdAt: Date.now(),
        ...overrides,
    };
}

// We need to dynamically import after clearing IndexedDB to avoid stale DB connections.
async function getModule() {
    // Clear module cache to get a fresh DB connection each time
    const mod = await import('@/lib/upload-state');
    return mod;
}

describe('upload-state (IndexedDB)', () => {
    beforeEach(async () => {
        // Delete the database to ensure a clean state between tests
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase('bolter-uploads');
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => resolve(); // proceed even if blocked
        });
    });

    describe('saveUploadState + getResumableUpload', () => {
        it('round-trips an upload state', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            const upload = makeUpload({
                fileName: 'round-trip.bin',
                fileSize: 5000,
                fileLastModified: 1700000000000,
            });

            await saveUploadState(upload);
            const result = await getResumableUpload('round-trip.bin', 5000, 1700000000000);

            expect(result).not.toBeNull();
            expect(result?.fileId).toBe(upload.fileId);
            expect(result?.uploadId).toBe(upload.uploadId);
            expect(result?.ownerToken).toBe(upload.ownerToken);
            expect(result?.fileName).toBe(upload.fileName);
            expect(result?.fileSize).toBe(upload.fileSize);
            expect(result?.encrypted).toBe(upload.encrypted);
            expect(result?.completedParts).toEqual(upload.completedParts);
            expect(result?.totalParts).toBe(upload.totalParts);
        });

        it('preserves optional fields like secretKeyB64', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            const upload = makeUpload({
                fileName: 'encrypted.bin',
                fileSize: 2000,
                fileLastModified: 1700000000000,
                encrypted: true,
                secretKeyB64: 'abcdef123456',
            });

            await saveUploadState(upload);
            const result = await getResumableUpload('encrypted.bin', 2000, 1700000000000);

            expect(result?.secretKeyB64).toBe('abcdef123456');
            expect(result?.encrypted).toBe(true);
        });
    });

    describe('getResumableUpload matching', () => {
        it('matches by fileName + fileSize + fileLastModified', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            const upload = makeUpload({
                fileName: 'match.bin',
                fileSize: 9999,
                fileLastModified: 1234567890,
            });

            await saveUploadState(upload);

            const result = await getResumableUpload('match.bin', 9999, 1234567890);
            expect(result).not.toBeNull();
            expect(result?.fileId).toBe(upload.fileId);
        });

        it('returns null when fileName does not match', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({ fileName: 'a.bin', fileSize: 100, fileLastModified: 1000 }),
            );

            const result = await getResumableUpload('b.bin', 100, 1000);
            expect(result).toBeNull();
        });

        it('returns null when fileSize does not match', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({ fileName: 'a.bin', fileSize: 100, fileLastModified: 1000 }),
            );

            const result = await getResumableUpload('a.bin', 200, 1000);
            expect(result).toBeNull();
        });

        it('returns null when fileLastModified does not match', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({ fileName: 'a.bin', fileSize: 100, fileLastModified: 1000 }),
            );

            const result = await getResumableUpload('a.bin', 100, 2000);
            expect(result).toBeNull();
        });

        it('returns the most recent match by createdAt', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            const older = makeUpload({
                fileId: 'older',
                fileName: 'same.bin',
                fileSize: 500,
                fileLastModified: 1000,
                createdAt: 1000,
            });
            const newer = makeUpload({
                fileId: 'newer',
                fileName: 'same.bin',
                fileSize: 500,
                fileLastModified: 1000,
                createdAt: 2000,
            });

            await saveUploadState(older);
            await saveUploadState(newer);

            const result = await getResumableUpload('same.bin', 500, 1000);
            expect(result).not.toBeNull();
            expect(result?.fileId).toBe('newer');
        });

        it('returns null when database is empty', async () => {
            const { getResumableUpload } = await getModule();
            const result = await getResumableUpload('nonexistent.bin', 100, 1000);
            expect(result).toBeNull();
        });
    });

    describe('updateCompletedPart', () => {
        it('adds a part to completedParts', async () => {
            const { saveUploadState, updateCompletedPart, getResumableUpload } = await getModule();
            const upload = makeUpload({
                fileName: 'parts.bin',
                fileSize: 1000,
                fileLastModified: 1000,
                completedParts: [],
            });

            await saveUploadState(upload);
            await updateCompletedPart(upload.fileId, { PartNumber: 1, ETag: '"etag1"' });

            const result = await getResumableUpload('parts.bin', 1000, 1000);
            expect(result?.completedParts).toHaveLength(1);
            expect(result?.completedParts[0]).toEqual({ PartNumber: 1, ETag: '"etag1"' });
        });

        it('adds multiple parts', async () => {
            const { saveUploadState, updateCompletedPart, getResumableUpload } = await getModule();
            const upload = makeUpload({
                fileName: 'multi.bin',
                fileSize: 2000,
                fileLastModified: 2000,
            });

            await saveUploadState(upload);
            await updateCompletedPart(upload.fileId, { PartNumber: 1, ETag: '"etag1"' });
            await updateCompletedPart(upload.fileId, { PartNumber: 2, ETag: '"etag2"' });
            await updateCompletedPart(upload.fileId, { PartNumber: 3, ETag: '"etag3"' });

            const result = await getResumableUpload('multi.bin', 2000, 2000);
            expect(result?.completedParts).toHaveLength(3);
        });

        it('deduplicates by PartNumber', async () => {
            const { saveUploadState, updateCompletedPart, getResumableUpload } = await getModule();
            const upload = makeUpload({
                fileName: 'dedup.bin',
                fileSize: 3000,
                fileLastModified: 3000,
            });

            await saveUploadState(upload);
            await updateCompletedPart(upload.fileId, { PartNumber: 1, ETag: '"etag1"' });
            await updateCompletedPart(upload.fileId, { PartNumber: 1, ETag: '"etag1-retry"' });

            const result = await getResumableUpload('dedup.bin', 3000, 3000);
            expect(result?.completedParts).toHaveLength(1);
            expect(result?.completedParts[0].ETag).toBe('"etag1"'); // first one kept
        });

        it('does nothing if fileId does not exist', async () => {
            const { updateCompletedPart, getAnyResumableUpload } = await getModule();
            // Should not throw
            await updateCompletedPart('nonexistent', { PartNumber: 1, ETag: '"etag"' });
            const result = await getAnyResumableUpload();
            expect(result).toBeNull();
        });
    });

    describe('getAnyResumableUpload', () => {
        it('returns an entry when uploads exist', async () => {
            const { saveUploadState, getAnyResumableUpload } = await getModule();
            const upload = makeUpload();
            await saveUploadState(upload);

            const result = await getAnyResumableUpload();
            expect(result).not.toBeNull();
            expect(result?.fileId).toBe(upload.fileId);
        });

        it('returns null when database is empty', async () => {
            const { getAnyResumableUpload } = await getModule();
            const result = await getAnyResumableUpload();
            expect(result).toBeNull();
        });
    });

    describe('deleteUploadState', () => {
        it('removes the specified entry', async () => {
            const { saveUploadState, deleteUploadState, getAnyResumableUpload } = await getModule();
            const upload = makeUpload();
            await saveUploadState(upload);

            await deleteUploadState(upload.fileId);

            const result = await getAnyResumableUpload();
            expect(result).toBeNull();
        });

        it('does not affect other entries', async () => {
            const { saveUploadState, deleteUploadState, getAnyResumableUpload } = await getModule();
            const upload1 = makeUpload({ fileId: 'keep-me' });
            const upload2 = makeUpload({ fileId: 'delete-me' });

            await saveUploadState(upload1);
            await saveUploadState(upload2);

            await deleteUploadState('delete-me');

            const result = await getAnyResumableUpload();
            expect(result).not.toBeNull();
            expect(result?.fileId).toBe('keep-me');
        });

        it('does not throw for nonexistent fileId', async () => {
            const { deleteUploadState } = await getModule();
            await expect(deleteUploadState('nonexistent')).resolves.toBeUndefined();
        });
    });

    describe('version gating (poisoned pre-v2 encrypted resume state)', () => {
        it('stamps new state with the current schema version', async () => {
            const { saveUploadState, getAnyResumableUpload, UPLOAD_STATE_VERSION } =
                await getModule();
            await saveUploadState(makeUpload());

            const result = await getAnyResumableUpload();
            expect(result?.version).toBe(UPLOAD_STATE_VERSION);
        });

        it('deletes pre-v2 encrypted state with completed parts on discovery', async () => {
            const { saveUploadState, getResumableUpload, getAnyResumableUpload } =
                await getModule();
            await saveUploadState(
                makeUpload({
                    version: 1,
                    fileName: 'poisoned.bin',
                    fileSize: 100,
                    fileLastModified: 1000,
                    encrypted: true,
                    secretKeyB64: 'abcdef123456',
                    completedParts: [{ PartNumber: 1, ETag: '"etag1"' }],
                }),
            );

            const result = await getResumableUpload('poisoned.bin', 100, 1000);
            expect(result).toBeNull();
            // The poisoned entry must be gone entirely, not just skipped
            expect(await getAnyResumableUpload()).toBeNull();
        });

        it('deletes pre-v2 encrypted state via getAnyResumableUpload too', async () => {
            const { saveUploadState, getAnyResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({
                    version: 1,
                    encrypted: true,
                    completedParts: [{ PartNumber: 1, ETag: '"etag1"' }],
                }),
            );

            expect(await getAnyResumableUpload()).toBeNull();
            expect(await getAnyResumableUpload()).toBeNull();
        });

        it('keeps pre-v2 unencrypted state with completed parts', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({
                    version: 1,
                    fileName: 'plain.bin',
                    fileSize: 100,
                    fileLastModified: 1000,
                    encrypted: false,
                    completedParts: [{ PartNumber: 1, ETag: '"etag1"' }],
                }),
            );

            const result = await getResumableUpload('plain.bin', 100, 1000);
            expect(result).not.toBeNull();
        });

        it('keeps pre-v2 encrypted state without completed parts', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({
                    version: 1,
                    fileName: 'no-parts.bin',
                    fileSize: 100,
                    fileLastModified: 1000,
                    encrypted: true,
                    completedParts: [],
                }),
            );

            const result = await getResumableUpload('no-parts.bin', 100, 1000);
            expect(result).not.toBeNull();
        });

        it('keeps v2 encrypted state with completed parts', async () => {
            const { saveUploadState, getResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({
                    fileName: 'v2.bin',
                    fileSize: 100,
                    fileLastModified: 1000,
                    encrypted: true,
                    completedParts: [{ PartNumber: 1, ETag: '"etag1"' }],
                }),
            );

            const result = await getResumableUpload('v2.bin', 100, 1000);
            expect(result).not.toBeNull();
        });

        it('skips a poisoned entry but returns a valid one', async () => {
            const { saveUploadState, getAnyResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({
                    fileId: 'aaa-poisoned',
                    version: 1,
                    encrypted: true,
                    completedParts: [{ PartNumber: 1, ETag: '"etag1"' }],
                }),
            );
            await saveUploadState(makeUpload({ fileId: 'zzz-valid' }));

            const result = await getAnyResumableUpload();
            expect(result?.fileId).toBe('zzz-valid');
        });
    });

    describe('cleanupExpiredUploads', () => {
        it('removes entries older than 7 days', async () => {
            const { saveUploadState, cleanupExpiredUploads, getAnyResumableUpload } =
                await getModule();
            const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
            const upload = makeUpload({ createdAt: eightDaysAgo });

            await saveUploadState(upload);
            await cleanupExpiredUploads();

            const result = await getAnyResumableUpload();
            expect(result).toBeNull();
        });

        it('keeps entries newer than 7 days', async () => {
            const { saveUploadState, cleanupExpiredUploads, getAnyResumableUpload } =
                await getModule();
            const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;
            const upload = makeUpload({ createdAt: oneDayAgo });

            await saveUploadState(upload);
            await cleanupExpiredUploads();

            const result = await getAnyResumableUpload();
            expect(result).not.toBeNull();
            expect(result?.fileId).toBe(upload.fileId);
        });

        it('removes expired but keeps recent entries', async () => {
            const { saveUploadState, cleanupExpiredUploads, getResumableUpload } =
                await getModule();

            const expired = makeUpload({
                fileId: 'expired',
                fileName: 'old.bin',
                fileSize: 100,
                fileLastModified: 100,
                createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
            });
            const recent = makeUpload({
                fileId: 'recent',
                fileName: 'new.bin',
                fileSize: 200,
                fileLastModified: 200,
                createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago
            });

            await saveUploadState(expired);
            await saveUploadState(recent);
            await cleanupExpiredUploads();

            const expiredResult = await getResumableUpload('old.bin', 100, 100);
            expect(expiredResult).toBeNull();

            const recentResult = await getResumableUpload('new.bin', 200, 200);
            expect(recentResult).not.toBeNull();
            expect(recentResult?.fileId).toBe('recent');
        });

        it('handles empty database without error', async () => {
            const { cleanupExpiredUploads } = await getModule();
            await expect(cleanupExpiredUploads()).resolves.toBeUndefined();
        });

        it('keeps entries exactly at the 7-day boundary', async () => {
            const { saveUploadState, cleanupExpiredUploads, getAnyResumableUpload } =
                await getModule();
            // Exactly 7 days minus 1 second
            const justUnder = Date.now() - (7 * 24 * 60 * 60 * 1000 - 1000);
            const upload = makeUpload({ createdAt: justUnder });

            await saveUploadState(upload);
            await cleanupExpiredUploads();

            const result = await getAnyResumableUpload();
            expect(result).not.toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // Finding 43 — resume identity must include file content. State that has
    // completed parts but no fingerprint cannot prove the re-selected file
    // matches the uploaded prefix, so it must not be offered for resume.
    // -----------------------------------------------------------------------
    describe('content fingerprint gating', () => {
        it('refuses to offer state with completed parts and no fingerprint', async () => {
            const { saveUploadState, getResumableUpload, getAnyResumableUpload } =
                await getModule();
            await saveUploadState(
                makeUpload({
                    fileName: 'no-fp.bin',
                    fileSize: 100,
                    fileLastModified: 1000,
                    contentFingerprint: undefined,
                    completedParts: [{ PartNumber: 1, ETag: '"etag1"' }],
                }),
            );

            expect(await getResumableUpload('no-fp.bin', 100, 1000)).toBeNull();
            expect(await getAnyResumableUpload()).toBeNull();
        });

        it('still offers fingerprint-less state that has no completed parts', async () => {
            // Nothing has been uploaded yet, so there is no prefix to splice a
            // different file onto — resuming just uploads the file from zero.
            const { saveUploadState, getResumableUpload } = await getModule();
            await saveUploadState(
                makeUpload({
                    fileName: 'fresh.bin',
                    fileSize: 100,
                    fileLastModified: 1000,
                    contentFingerprint: undefined,
                    completedParts: [],
                }),
            );

            expect(await getResumableUpload('fresh.bin', 100, 1000)).not.toBeNull();
        });
    });

    describe('computeContentFingerprint', () => {
        it('is stable for identical content', async () => {
            const { computeContentFingerprint } = await getModule();
            const a = new Blob([new Uint8Array(5_000_000).fill(3)]);
            const b = new Blob([new Uint8Array(5_000_000).fill(3)]);

            expect(await computeContentFingerprint(a)).toBe(await computeContentFingerprint(b));
        });

        it('differs for same-size files with different content', async () => {
            const { computeContentFingerprint } = await getModule();
            const a = new Blob([new Uint8Array(5_000_000).fill(3)]);
            const b = new Blob([new Uint8Array(5_000_000).fill(4)]);

            expect(await computeContentFingerprint(a)).not.toBe(await computeContentFingerprint(b));
        });

        it('differs when only the size differs', async () => {
            const { computeContentFingerprint } = await getModule();
            const a = new Blob([new Uint8Array(1000)]);
            const b = new Blob([new Uint8Array(1001)]);

            expect(await computeContentFingerprint(a)).not.toBe(await computeContentFingerprint(b));
        });

        it('detects a difference in the head of a large file', async () => {
            const { computeContentFingerprint } = await getModule();
            const base = new Uint8Array(6_000_000);
            const modified = new Uint8Array(6_000_000);
            modified[0] = 1;

            expect(await computeContentFingerprint(new Blob([base]))).not.toBe(
                await computeContentFingerprint(new Blob([modified])),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Finding 21 — a merged final part breaks the fixed-part-size offset math a
    // resume relies on. The pre-fix guard was a fire-and-forget delete racing an
    // updateCompletedPart in a separate IndexedDB transaction: if the delete
    // lost (or failed), poisoned state survived and could be resumed into a
    // corrupt object. Marking the file ID in memory must be authoritative.
    // -----------------------------------------------------------------------
    describe('discardUploadState', () => {
        // Writes straight to IndexedDB, bypassing the module's write guards —
        // this is what "an updateCompletedPart that lost the race" leaves behind.
        function rawPut(state: PersistedUpload): Promise<void> {
            return new Promise((resolve, reject) => {
                const open = indexedDB.open('bolter-uploads', 1);
                open.onupgradeneeded = () => {
                    const db = open.result;
                    if (!db.objectStoreNames.contains('uploads')) {
                        db.createObjectStore('uploads', { keyPath: 'fileId' });
                    }
                };
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction('uploads', 'readwrite');
                    tx.objectStore('uploads').put({ ...state, version: 3 });
                    tx.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    tx.onerror = () => {
                        db.close();
                        reject(tx.error);
                    };
                };
                open.onerror = () => reject(open.error);
            });
        }

        it('keeps the upload unresumable even if the record survives the delete', async () => {
            const { saveUploadState, discardUploadState, getAnyResumableUpload } =
                await getModule();
            const upload = makeUpload({
                fileId: 'merged-part-upload',
                completedParts: [{ PartNumber: 1, ETag: '"etag1"' }],
            });
            await saveUploadState(upload);

            await discardUploadState(upload.fileId);

            // The delete lost the race with a write that was already in flight
            await rawPut({
                ...upload,
                completedParts: [
                    { PartNumber: 1, ETag: '"etag1"' },
                    { PartNumber: 2, ETag: '"etag2"' },
                ],
            });

            // Pre-fix (plain deleteUploadState) this returned the resurrected,
            // poisoned state and offered it for resume.
            expect(await getAnyResumableUpload()).toBeNull();
        });

        it('suppresses later writes for a discarded upload', async () => {
            const {
                saveUploadState,
                discardUploadState,
                updateCompletedPart,
                isUploadNonResumable,
            } = await getModule();
            const upload = makeUpload({ fileId: 'suppressed-upload' });
            await saveUploadState(upload);

            // Marked synchronously — before the delete has any chance to land
            const discarding = discardUploadState(upload.fileId);
            expect(isUploadNonResumable(upload.fileId)).toBe(true);
            await discarding;

            await updateCompletedPart(upload.fileId, { PartNumber: 1, ETag: '"etag1"' });
            await saveUploadState(upload);

            const { getAnyResumableUpload } = await getModule();
            expect(await getAnyResumableUpload()).toBeNull();
        });
    });
});
