import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeXhr, multipartUploadInfo } from './upload-xhr-fake';

// The slice-based multipart path is selected for WebKit + unencrypted +
// single-file uploads. `isWebKit` is computed once at module load, so the
// navigator stub must be installed before importing the module under test.
const navigatorStub = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    onLine: true,
};
vi.stubGlobal('navigator', navigatorStub);

const { uploadFiles, Canceller } = await import('@/lib/api');
const { Keychain } = await import('@bolter/protocol/crypto');

const PART_SIZE = 1024 * 1024;
// R2/S3 reject non-trailing parts below 5 MiB, and the uploader hard-fails on
// that before completing — so any test that runs to completion needs real parts.
const LEGAL_PART_SIZE = 6 * 1024 * 1024;

function makeFile(bytes: number, declaredSize?: number): File {
    const file = new File([new Uint8Array(bytes)], 'video.mov', {
        type: 'video/quicktime',
        lastModified: 1700000000000,
    });
    if (declaredSize !== undefined) {
        Object.defineProperty(file, 'size', { value: declaredSize });
    }
    return file;
}

describe('slice-based multipart upload (WebKit path)', () => {
    let fetchCalls: string[];
    let uploadUrlResponse: ReturnType<typeof multipartUploadInfo>;

    beforeEach(async () => {
        uploadUrlResponse = multipartUploadInfo(10, PART_SIZE);
        await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase('bolter-uploads');
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
        });

        navigatorStub.onLine = true;
        vi.stubGlobal('navigator', navigatorStub);
        FakeXhr.reset();
        vi.stubGlobal('XMLHttpRequest', FakeXhr);

        fetchCalls = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                const u = String(url);
                fetchCalls.push(u);
                if (u.includes('/upload/url')) {
                    return Promise.resolve(
                        new Response(JSON.stringify(uploadUrlResponse), { status: 200 }),
                    );
                }
                if (u.includes('/upload/abort/')) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ success: true }), { status: 200 }),
                    );
                }
                if (u.includes('/upload/complete')) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ success: true, id: 'file-id', url: 'x' }), {
                            status: 200,
                        }),
                    );
                }
                return Promise.reject(new Error(`Unexpected fetch: ${u}`));
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // -----------------------------------------------------------------------
    // Finding 3 (HIGH) — Cancel must stop parts that have not started yet.
    // Canceller.cancel() only aborts the XHRs in flight at that instant; with
    // every part pre-queued up front, the pre-fix processQueue kept launching
    // fresh XHRs after cancellation and uploaded the entire remaining file.
    // -----------------------------------------------------------------------
    it('stops uploading queued parts once cancelled', async () => {
        const canceller = new Canceller();

        FakeXhr.onSend = (xhr) => {
            // Cancel once the first concurrency window is saturated
            if (FakeXhr.sends.length === 3) {
                queueMicrotask(() => canceller.cancel());
            } else {
                queueMicrotask(() => xhr.succeed());
            }
        };

        const promise = uploadFiles(
            { files: [makeFile(10 * PART_SIZE)], encrypted: false },
            new Keychain(),
            canceller,
        );

        await expect(promise).rejects.toThrow('Upload cancelled');

        // 10 parts were queued; only the 3 in-flight ones may ever be sent.
        // Pre-fix this was 10 — the whole file uploaded after Cancel.
        expect(FakeXhr.sends.length).toBe(3);
        // And the server-side multipart is aborted rather than deferred until
        // the last part finishes
        expect(fetchCalls.some((u) => u.includes('/upload/abort/'))).toBe(true);
        expect(fetchCalls.some((u) => u.includes('/upload/complete'))).toBe(false);
    });

    it('settles instead of hanging when cancelled before any part starts', async () => {
        const canceller = new Canceller();
        canceller.cancel();

        await expect(
            uploadFiles(
                { files: [makeFile(10 * PART_SIZE)], encrypted: false },
                new Keychain(),
                canceller,
            ),
        ).rejects.toThrow('Upload cancelled');

        expect(FakeXhr.sends.length).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Finding 50 — an empty slice was skipped without adjusting the expected
    // part count, so `finished` stayed permanently below `queued` and
    // `allDonePromise` never resolved: the upload hung with no error at all.
    // If the fix regresses, this test times out rather than failing fast.
    // -----------------------------------------------------------------------
    it('completes when a trailing slice is unexpectedly empty', async () => {
        uploadUrlResponse = multipartUploadInfo(10, LEGAL_PART_SIZE);
        // The server allocated 10 parts, but the file only has content for 3.
        // Parts 4..10 slice to zero bytes and are skipped.
        const file = makeFile(3 * LEGAL_PART_SIZE, 10 * LEGAL_PART_SIZE);

        const result = await uploadFiles(
            { files: [file], encrypted: false },
            new Keychain(),
            new Canceller(),
        );

        expect(result.id).toBe('file-id');
        expect(FakeXhr.sends.length).toBe(3);
    });
});
