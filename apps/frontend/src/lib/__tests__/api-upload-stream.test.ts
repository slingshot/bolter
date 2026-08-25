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
const { Keychain } = await import('@bolter/protocol/crypto');

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
    let fetchBodies: Array<{ url: string; body: Record<string, unknown> }>;
    let uploadUrlResponse: Record<string, unknown>;

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
        fetchCalls = [];
        fetchBodies = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit) => {
                const u = String(url);
                fetchCalls.push(u);
                if (typeof init?.body === 'string') {
                    try {
                        fetchBodies.push({ url: u, body: JSON.parse(init.body) });
                    } catch {
                        /* non-JSON body — not interesting to these tests */
                    }
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

    // Finding 31's test ("aborts the speed test on cancel and never requests
    // upload URLs") is gone with its subject: there is no preflight window left
    // to cancel inside. The guard it protected — no allocation for an
    // already-cancelled upload — is still covered by 'does not open a request
    // for an already-cancelled upload' below.
    it('should never request a speed test', async () => {
        // The preflight probe is gone: up to 500MB and 10s per upload, spent
        // to pick between four constants the server now derives itself.
        const bigPartSize = 10 * 1024 * 1024;
        uploadUrlResponse = multipartUploadInfo(20, bigPartSize);

        const result = await uploadFiles(
            {
                // Above MULTIPART_THRESHOLD, so the preflight used to fire here.
                files: [chunkedFile('archive.bin', 150 * 1024 * 1024, bigPartSize)],
                encrypted: false,
            },
            new Keychain(),
            new Canceller(),
        );

        expect(result.id).toBe('file-id');
        expect(fetchCalls.filter((u) => u.includes('/upload/speedtest'))).toEqual([]);
        const urlCall = fetchBodies.find((b) => b.url.includes('/upload/url'));
        expect(urlCall?.body).not.toHaveProperty('preferredPartSize');
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

        it('reports a mid-flight cancel as "Upload cancelled", not a raw HTTP error', async () => {
            const canceller = new Canceller();

            // The PUT never settles on its own — only the cancel's abort ends it
            FakeXhr.onSend = () => {
                /* park in flight */
            };

            const promise = uploadFiles(
                { files: [makeFile(1024)], encrypted: false },
                new Keychain(),
                canceller,
            );

            // Wait for the PUT to actually be in flight
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(FakeXhr.sends.length).toBe(1);

            canceller.cancel();

            // Pre-fix: abort dispatches loadend with status 0, uploadSinglePart
            // rejected with "HTTP 0" and the retry wrapper rethrew it verbatim,
            // so Home.tsx showed "Upload failed: HTTP 0" instead of the cancel
            // toast (uploadFiles' own cancelled check sits after the await).
            await expect(promise).rejects.toThrow('Upload cancelled');
            expect(FakeXhr.instances[0].aborted).toBe(true);
            // The cancel still releases the server-side allocation
            expect(fetchCalls.some((u) => u.includes('/delete/file-id'))).toBe(true);
            expect(fetchCalls.some((u) => u.includes('/upload/complete'))).toBe(false);
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
