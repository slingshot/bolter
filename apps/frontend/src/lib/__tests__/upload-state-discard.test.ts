import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for finding #45: discarding resume state locally without
// aborting the server-side multipart leaves billable S3 parts behind and leaves
// the provider file counter permanently incremented.
const abortServerMultipart = vi.fn<(fileId: string, uploadId: string) => Promise<boolean>>();
vi.mock('@/lib/multipart-abort', () => ({
    abortServerMultipart: (fileId: string, uploadId: string) =>
        abortServerMultipart(fileId, uploadId),
}));

import type { PersistedUpload } from '@/lib/upload-state';

function makeUpload(overrides: Partial<PersistedUpload> = {}): PersistedUpload {
    return {
        fileId: `file-${Math.random().toString(36).slice(2)}`,
        uploadId: `upload-${Math.random().toString(36).slice(2)}`,
        ownerToken: 'owner-token-123',
        fileName: 'test-file.bin',
        fileSize: 1_000_000,
        fileLastModified: 1700000000000,
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

function getModule() {
    return import('@/lib/upload-state');
}

describe('discarding resumable uploads aborts the server-side multipart', () => {
    beforeEach(async () => {
        abortServerMultipart.mockReset();
        abortServerMultipart.mockResolvedValue(true);
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase('bolter-uploads');
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => resolve();
        });
    });

    describe('discardResumableUpload', () => {
        it('aborts the multipart and then drops the local record', async () => {
            const { saveUploadState, discardResumableUpload, getAnyResumableUpload } =
                await getModule();
            const upload = makeUpload({ fileId: 'discard-me', uploadId: 'mp-abc' });
            await saveUploadState(upload);

            await discardResumableUpload({ fileId: 'discard-me', uploadId: 'mp-abc' });

            expect(abortServerMultipart).toHaveBeenCalledWith('discard-me', 'mp-abc');
            expect(await getAnyResumableUpload()).toBeNull();
        });

        it('still drops the local record when the abort fails', async () => {
            const { saveUploadState, discardResumableUpload, getAnyResumableUpload } =
                await getModule();
            abortServerMultipart.mockResolvedValue(false);
            await saveUploadState(makeUpload({ fileId: 'offline', uploadId: 'mp-off' }));

            await discardResumableUpload({ fileId: 'offline', uploadId: 'mp-off' });

            expect(abortServerMultipart).toHaveBeenCalledWith('offline', 'mp-off');
            expect(await getAnyResumableUpload()).toBeNull();
        });
    });

    describe('cleanupExpiredUploads', () => {
        it('aborts the multipart for every record it reaps', async () => {
            const { saveUploadState, cleanupExpiredUploads, getAnyResumableUpload } =
                await getModule();
            const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
            await saveUploadState(
                makeUpload({ fileId: 'stale-1', uploadId: 'mp-1', createdAt: tenDaysAgo }),
            );
            await saveUploadState(
                makeUpload({
                    fileId: 'stale-2',
                    uploadId: 'mp-2',
                    fileName: 'other.bin',
                    createdAt: tenDaysAgo,
                }),
            );

            await cleanupExpiredUploads();

            expect(abortServerMultipart).toHaveBeenCalledTimes(2);
            expect(abortServerMultipart).toHaveBeenCalledWith('stale-1', 'mp-1');
            expect(abortServerMultipart).toHaveBeenCalledWith('stale-2', 'mp-2');
            expect(await getAnyResumableUpload()).toBeNull();
        });

        it('does not abort multiparts for records that are still resumable', async () => {
            const { saveUploadState, cleanupExpiredUploads, getAnyResumableUpload } =
                await getModule();
            await saveUploadState(
                makeUpload({
                    fileId: 'fresh',
                    uploadId: 'mp-fresh',
                    createdAt: Date.now() - 24 * 60 * 60 * 1000,
                }),
            );

            await cleanupExpiredUploads();

            expect(abortServerMultipart).not.toHaveBeenCalled();
            expect((await getAnyResumableUpload())?.fileId).toBe('fresh');
        });

        it('deletes the stale record even when the abort call rejects', async () => {
            const { saveUploadState, cleanupExpiredUploads, getAnyResumableUpload } =
                await getModule();
            abortServerMultipart.mockRejectedValue(new Error('boom'));
            await saveUploadState(
                makeUpload({
                    fileId: 'stale-throw',
                    uploadId: 'mp-throw',
                    createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
                }),
            );

            await cleanupExpiredUploads();

            expect(await getAnyResumableUpload()).toBeNull();
        });
    });
});
