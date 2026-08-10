import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkedFile, FakeXhr, multipartUploadInfo } from './upload-xhr-fake';

// Non-WebKit UA so the stream-based multipart path is selected. `isWebKit` is
// computed once at module load, so the stub must precede the import.
const navigatorStub = {
    userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    onLine: true,
};
vi.stubGlobal('navigator', navigatorStub);

const { uploadFiles, Canceller } = await import('@/lib/api');
const { Keychain } = await import('@/lib/crypto');

const PART_SIZE = 1024 * 1024;

function makeFile(bytes: number, declaredSize?: number): File {
    const file = new File([new Uint8Array(bytes)], 'archive.bin', {
        type: 'application/octet-stream',
        lastModified: 1700000000000,
    });
    if (declaredSize !== undefined) {
        Object.defineProperty(file, 'size', { value: declaredSize });
    }
    return file;
}

describe('stream-based multipart upload', () => {
    let fetchCalls: string[];
    let uploadUrlResponse: Record<string, unknown>;
    let speedtestParts: number;

    beforeEach(async () => {
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

        uploadUrlResponse = multipartUploadInfo(20, PART_SIZE);
        speedtestParts = 5;
        fetchCalls = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                const u = String(url);
                fetchCalls.push(u);
                if (u.includes('/upload/speedtest/cleanup')) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ success: true }), { status: 200 }),
                    );
                }
                if (u.includes('/upload/speedtest')) {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                testId: 'speedtest-id',
                                uploadId: 'speedtest-upload',
                                parts: Array.from({ length: speedtestParts }, (_, i) => ({
                                    partNumber: i + 1,
                                    url: `https://s3.example.com/speedtest${i + 1}`,
                                })),
                            }),
                            { status: 200 },
                        ),
                    );
                }
                if (u.includes('/upload/url')) {
                    return Promise.resolve(
                        new Response(JSON.stringify(uploadUrlResponse), { status: 200 }),
                    );
                }
                if (u.includes('/upload/abort/') || u.includes('/delete/')) {
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
        vi.useRealTimers();
    });

    // -----------------------------------------------------------------------
    // Finding 3 — cancellation must stop parts that have not started yet on
    // the streaming path too.
    // -----------------------------------------------------------------------
    it('never starts a queued part after cancellation', async () => {
        const canceller = new Canceller();
        let sendsAfterCancel = 0;

        // Parts never complete on their own: the concurrency window fills up
        // and the read loop parks with a part waiting in the queue.
        FakeXhr.onSend = () => {
            if (canceller.cancelled) {
                sendsAfterCancel++;
            }
        };

        const promise = uploadFiles(
            { files: [chunkedFile('archive.bin', 20 * PART_SIZE, PART_SIZE)], encrypted: false },
            new Keychain(),
            canceller,
        );

        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(FakeXhr.sends.length).toBe(3);

        canceller.cancel();
        await expect(promise).rejects.toThrow('Upload cancelled');

        // Pre-fix, aborting the in-flight XHRs ran their `finally`, which called
        // processQueue() and started the part still sitting in the queue.
        expect(sendsAfterCancel).toBe(0);
        expect(FakeXhr.sends.length).toBe(3);
        expect(fetchCalls.some((u) => u.includes('/upload/complete'))).toBe(false);
        expect(fetchCalls.some((u) => u.includes('/upload/abort/'))).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Finding 13 — the first PERMANENT part failure must short-circuit the
    // upload. Pre-fix, failures were only inspected after the whole stream had
    // been read, encrypted and uploaded, so a doomed 500GB upload still
    // transferred every remaining byte before reporting the error.
    // -----------------------------------------------------------------------
    it('short-circuits after a permanently failed part instead of uploading the rest', async () => {
        FakeXhr.onSend = (xhr) => {
            queueMicrotask(() => {
                if (xhr.url.endsWith('/part1')) {
                    // 403 is not in isRetryableError — permanent, no retries
                    xhr.failWithStatus(403, 'Forbidden');
                } else {
                    xhr.succeed();
                }
            });
        };

        await expect(
            uploadFiles(
                {
                    files: [chunkedFile('archive.bin', 20 * PART_SIZE, PART_SIZE)],
                    encrypted: false,
                },
                new Keychain(),
                new Canceller(),
            ),
        ).rejects.toThrow(/Failed to upload 1 parts: 1/);

        // Bounded by the concurrency window + backpressure buffer; pre-fix all
        // 20 parts were sent before the failure surfaced.
        expect(FakeXhr.sends.length).toBeLessThanOrEqual(6);
        expect(fetchCalls.some((u) => u.includes('/upload/complete'))).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Finding 30 — waitForOnline must race against cancellation. Pre-fix, a
    // part that failed while offline parked forever on the `online` event, so
    // allDonePromise never resolved and uploadFiles never settled (this test
    // would time out rather than fail).
    // -----------------------------------------------------------------------
    it('settles when cancelled while a retry is waiting for connectivity', async () => {
        const canceller = new Canceller();

        FakeXhr.onSend = (xhr) => {
            queueMicrotask(() => {
                navigatorStub.onLine = false;
                // Retryable failure → uploadPartWithRetry awaits waitForOnline
                xhr.failWithNetworkError();
            });
        };

        const promise = uploadFiles(
            { files: [chunkedFile('archive.bin', 20 * PART_SIZE, PART_SIZE)], encrypted: false },
            new Keychain(),
            canceller,
        );

        // Let the parts fail and park on the offline wait
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(FakeXhr.sends.length).toBeGreaterThan(0);

        canceller.cancel();

        await expect(promise).rejects.toThrow('Upload cancelled');
    });

    // -----------------------------------------------------------------------
    // Finding 31 — the preflight speed-test XHRs must be registered with the
    // Canceller, and cancelling during "Checking speed…" must stop before the
    // server-side multipart + metadata are created.
    // -----------------------------------------------------------------------
    it('aborts the speed test on cancel and never requests upload URLs', async () => {
        const canceller = new Canceller();

        FakeXhr.onSend = () => {
            // Never completes on its own — only cancellation can end the test
            if (FakeXhr.sends.length === speedtestParts) {
                queueMicrotask(() => canceller.cancel());
            }
        };

        // Declared size above MULTIPART_THRESHOLD so the preflight test runs,
        // with tiny real content so the test stays cheap.
        const file = makeFile(1024, 200 * 1024 * 1024);

        await expect(
            uploadFiles({ files: [file], encrypted: false }, new Keychain(), canceller),
        ).rejects.toThrow('Upload cancelled');

        expect(FakeXhr.sends.length).toBe(speedtestParts);
        expect(FakeXhr.instances.every((x) => x.aborted)).toBe(true);
        // Pre-fix the test ran its full 10s window and then created the upload
        expect(fetchCalls.some((u) => u.includes('/upload/url'))).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Finding 41 — the single-part path (<=100MB) had no retry, no stall
    // detection, no offline pause and no cleanup on terminal failure.
    // -----------------------------------------------------------------------
    describe('single-part upload', () => {
        beforeEach(() => {
            uploadUrlResponse = {
                useSignedUrl: true,
                multipart: false,
                id: 'file-id',
                owner: 'owner-token',
                url: 'https://s3.example.com/single',
            };
        });

        it('retries a transient network failure instead of discarding the upload', async () => {
            vi.useFakeTimers();

            FakeXhr.onSend = (xhr) => {
                queueMicrotask(() => {
                    if (FakeXhr.sends.length === 1) {
                        xhr.failWithNetworkError();
                    } else {
                        xhr.succeed();
                    }
                });
            };

            const promise = uploadFiles(
                { files: [makeFile(1024)], encrypted: false },
                new Keychain(),
                new Canceller(),
            );

            // Drain the retry backoff (2-3s for the first attempt)
            await vi.advanceTimersByTimeAsync(5000);

            const result = await promise;
            expect(result.id).toBe('file-id');
            // Pre-fix: one send, then a hard failure
            expect(FakeXhr.sends.length).toBe(2);
        });

        it('releases the server-side allocation on terminal failure', async () => {
            FakeXhr.onSend = (xhr) => {
                queueMicrotask(() => xhr.failWithStatus(403, 'Forbidden'));
            };

            await expect(
                uploadFiles(
                    { files: [makeFile(1024)], encrypted: false },
                    new Keychain(),
                    new Canceller(),
                ),
            ).rejects.toThrow(/HTTP 403/);

            // Pre-fix nothing cleaned up: the /upload/url metadata and the
            // provider file counter were stranded until TTL.
            expect(fetchCalls.some((u) => u.includes('/delete/file-id'))).toBe(true);
        });

        it('does not open a request for an already-cancelled upload', async () => {
            const canceller = new Canceller();
            canceller.cancel();

            await expect(
                uploadFiles(
                    { files: [makeFile(1024)], encrypted: false },
                    new Keychain(),
                    canceller,
                ),
            ).rejects.toThrow('Upload cancelled');

            expect(FakeXhr.sends.length).toBe(0);
        });
    });
});
