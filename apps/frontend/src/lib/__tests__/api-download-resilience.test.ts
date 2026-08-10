import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createResilientDownloadStream,
    fetchWithHeaderTimeout,
    isRangeResumeUnnecessary,
    PermanentDownloadError,
    StreamConsumerGoneError,
    shouldRetryDownloadAttempt,
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Body stream that yields `chunks`, then either ends cleanly, errors like a
 * severed connection, or hangs (the way a blackholed socket does) until the
 * reader is cancelled.
 */
function makeBody(
    chunks: Uint8Array[],
    after: 'close' | 'error' | 'hang',
): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index < chunks.length) {
                controller.enqueue(chunks[index]);
                index++;
                return;
            }
            if (after === 'close') {
                controller.close();
                return;
            }
            if (after === 'error') {
                controller.error(new Error('connection reset'));
                return;
            }
            // Never settles — the read only completes when cancelled
            return new Promise<void>(() => {
                /* intentionally pending */
            });
        },
    });
}

/** Minimal Response stand-in — only the fields the download path reads. */
function fakeResponse(init: {
    status?: number;
    headers?: Record<string, string>;
    body?: ReadableStream<Uint8Array> | null;
}): Response {
    const status = init.status ?? 200;
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(init.headers ?? {}),
        body: init.body ?? null,
    } as unknown as Response;
}

function installFetch(handler: (url: string, init: RequestInit) => Response) {
    const fn = vi.fn((url: unknown, init?: RequestInit) =>
        Promise.resolve(handler(String(url), init ?? {})),
    );
    vi.stubGlobal('fetch', fn);
    return fn;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        parts.push(value);
        total += value.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Pure retry policy (finding 18)
// ---------------------------------------------------------------------------

describe('shouldRetryDownloadAttempt', () => {
    it('never retries a 404/410 from the object store', () => {
        expect(
            shouldRetryDownloadAttempt(new PermanentDownloadError('Download failed: HTTP 410'), {
                failures: 0,
                maxRetries: 5,
            }),
        ).toBe(false);
    });

    it('never retries once the consumer is gone', () => {
        // The whole point of finding 18: an enqueue/close failure means the
        // stream is closed or errored, so no amount of refetching helps.
        expect(
            shouldRetryDownloadAttempt(new StreamConsumerGoneError('enqueue', new TypeError()), {
                failures: 0,
                maxRetries: 5,
            }),
        ).toBe(false);
    });

    it('still retries a bare TypeError, which is what fetch throws on network failure', () => {
        // Guards against the naive "treat every TypeError as terminal" fix,
        // which would disable resilience for genuine connection drops.
        expect(
            shouldRetryDownloadAttempt(new TypeError('Failed to fetch'), {
                failures: 0,
                maxRetries: 5,
            }),
        ).toBe(true);
    });

    it('retries a transient error while budget remains and stops when exhausted', () => {
        const err = new Error('connection reset');
        expect(shouldRetryDownloadAttempt(err, { failures: 4, maxRetries: 5 })).toBe(true);
        expect(shouldRetryDownloadAttempt(err, { failures: 5, maxRetries: 5 })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Pure range-completeness policy (finding 20)
// ---------------------------------------------------------------------------

describe('isRangeResumeUnnecessary', () => {
    it('is true once the received bytes cover the expected total', () => {
        expect(isRangeResumeUnnecessary(1000, 1000)).toBe(true);
        expect(isRangeResumeUnnecessary(1001, 1000)).toBe(true);
    });

    it('is false while bytes are still outstanding', () => {
        expect(isRangeResumeUnnecessary(999, 1000)).toBe(false);
    });

    it('is false when the total is unknown', () => {
        expect(isRangeResumeUnnecessary(1000, undefined)).toBe(false);
        expect(isRangeResumeUnnecessary(1000, 0)).toBe(false);
    });

    it('derives the total from the Content-Range a 416 carries', () => {
        expect(isRangeResumeUnnecessary(1000, undefined, 'bytes */1000')).toBe(true);
        expect(isRangeResumeUnnecessary(500, undefined, 'bytes */1000')).toBe(false);
    });

    it('ignores a malformed or satisfiable Content-Range', () => {
        expect(isRangeResumeUnnecessary(1000, undefined, 'bytes 0-99/1000')).toBe(false);
        expect(isRangeResumeUnnecessary(1000, undefined, 'nonsense')).toBe(false);
        expect(isRangeResumeUnnecessary(1000, undefined, null)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Header-phase stall guard (finding 19)
// ---------------------------------------------------------------------------

describe('fetchWithHeaderTimeout', () => {
    it('aborts a request whose response headers never arrive', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                (_url: unknown, init?: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () =>
                            reject(new Error('The operation was aborted')),
                        );
                    }),
            ),
        );

        await expect(fetchWithHeaderTimeout('https://obj.example/x', {}, 20)).rejects.toThrow(
            /Timed out waiting for response headers/,
        );
    });

    it('clears the timer on response so body transfer is never capped', async () => {
        let captured: AbortSignal | null | undefined;
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: unknown, init?: RequestInit) => {
                captured = init?.signal;
                return Promise.resolve(fakeResponse({}));
            }),
        );

        await fetchWithHeaderTimeout('https://obj.example/x', {}, 10);
        // Well past the header timeout — a long download must still be alive
        await tick(50);
        expect(captured?.aborted).toBe(false);
    });

    it('propagates a real network failure unchanged', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
        );
        await expect(fetchWithHeaderTimeout('https://obj.example/x', {}, 5000)).rejects.toThrow(
            /Failed to fetch/,
        );
    });
});

// ---------------------------------------------------------------------------
// Stream behaviour
// ---------------------------------------------------------------------------

describe('createResilientDownloadStream', () => {
    it('stops issuing requests once the consumer cancels (finding 18)', async () => {
        // Reproduces the runaway loop: cancel lands while pull() awaits a body
        // read, so controller.close() throws TypeError. Pre-fix that was
        // classified as retryable, and because `failures` reset on every chunk
        // the budget never exhausted — a fresh ranged GET roughly every second,
        // for hours, after "Download failed" was already shown.
        let attempts = 0;
        installFetch((_url, init) => {
            attempts++;
            const headers = (init.headers ?? {}) as Record<string, string>;
            const range = headers.Range;
            if (range) {
                const start = parseInt(/bytes=(\d+)-/.exec(range)?.[1] ?? '0', 10);
                return fakeResponse({
                    status: 206,
                    headers: { 'Content-Range': `bytes ${start}-${start + 7}/1000000` },
                    body: makeBody([new Uint8Array(8).fill(1)], 'hang'),
                });
            }
            return fakeResponse({ body: makeBody([new Uint8Array(8).fill(1)], 'hang') });
        });

        const stream = createResilientDownloadStream({
            getRequest: async () => ({ url: 'https://obj.example/file' }),
            retryDelays: [1],
            maxRetries: 5,
            stallTimeout: 10_000,
        });

        const reader = stream.getReader();
        const first = await reader.read();
        expect(first.value?.length).toBe(8);
        expect(attempts).toBe(1);

        // Second pull parks on the hanging body read, then the consumer goes away
        const pending = reader.read();
        await tick(0);
        await reader.cancel();
        await pending;

        // Generous window for a runaway retry loop to reveal itself
        await tick(120);
        expect(attempts).toBe(1);
    });

    it('reports a hung connect/header phase instead of waiting forever (finding 19)', async () => {
        // The read-side stall guard only arms once a reader exists, so a socket
        // that connects but never returns headers used to park the await with
        // no timer running at all.
        let attempts = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: unknown, init?: RequestInit) => {
                attempts++;
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(new Error('The operation was aborted')),
                    );
                });
            }),
        );

        const stream = createResilientDownloadStream({
            getRequest: async () => ({ url: 'https://obj.example/file' }),
            retryDelays: [1],
            maxRetries: 2,
            stallTimeout: 20,
        });

        const outcome = await Promise.race([
            readAll(stream).then(
                () => 'resolved',
                (e: unknown) => `rejected: ${(e as Error).message}`,
            ),
            tick(2000).then(() => 'HUNG'),
        ]);

        expect(outcome).not.toBe('HUNG');
        expect(outcome).toMatch(/Timed out waiting for response headers/);
        expect(attempts).toBe(3); // initial attempt + 2 retries
    });

    it('closes as complete rather than range-resuming a byte-complete transfer (finding 20)', async () => {
        // Connection died holding EOF: every byte arrived but `done` never came.
        // Pre-fix this asked for `Range: bytes=<size>-`, got 416, and discarded
        // a fully downloaded file.
        const total = 32;
        let resumeAttempts = 0;
        installFetch(() => {
            resumeAttempts++;
            return fakeResponse({
                status: 416,
                headers: { 'Content-Range': `bytes */${total}` },
            });
        });

        const stream = createResilientDownloadStream({
            firstResponse: fakeResponse({
                headers: { 'Content-Length': String(total) },
                body: makeBody([new Uint8Array(total).fill(7)], 'error'),
            }),
            expectedTotal: total,
            getRequest: async () => ({ url: 'https://obj.example/file' }),
            retryDelays: [1],
            maxRetries: 3,
        });

        const out = await readAll(stream);
        expect(out.length).toBe(total);
        expect(resumeAttempts).toBe(0); // never even asked for the empty tail
    });

    it('treats a 416 whose Content-Range shows the object is fully received as complete', async () => {
        // Same failure, but with no Content-Length on the first response
        // (the backend fallback stream route) so expectedTotal is unknown.
        const total = 32;
        installFetch(() =>
            fakeResponse({ status: 416, headers: { 'Content-Range': `bytes */${total}` } }),
        );

        const stream = createResilientDownloadStream({
            firstResponse: fakeResponse({
                body: makeBody([new Uint8Array(total).fill(3)], 'error'),
            }),
            getRequest: async () => ({ url: 'https://obj.example/file' }),
            retryDelays: [1],
            maxRetries: 3,
        });

        expect((await readAll(stream)).length).toBe(total);
    });

    it('still fails a 416 while bytes are genuinely outstanding', async () => {
        installFetch(() =>
            fakeResponse({ status: 416, headers: { 'Content-Range': 'bytes */100' } }),
        );

        const stream = createResilientDownloadStream({
            firstResponse: fakeResponse({
                headers: { 'Content-Length': '100' },
                body: makeBody([new Uint8Array(32)], 'error'),
            }),
            expectedTotal: 100,
            getRequest: async () => ({ url: 'https://obj.example/file' }),
            retryDelays: [1],
            maxRetries: 1,
        });

        await expect(readAll(stream)).rejects.toThrow(/HTTP 416/);
    });

    it('still range-resumes a genuinely interrupted transfer', async () => {
        // Regression guard: the completeness short-circuit must not swallow
        // real mid-stream failures.
        let resumeAttempts = 0;
        installFetch((_url, init) => {
            resumeAttempts++;
            const headers = (init.headers ?? {}) as Record<string, string>;
            expect(headers.Range).toBe('bytes=16-');
            return fakeResponse({
                status: 206,
                headers: { 'Content-Range': 'bytes 16-31/32' },
                body: makeBody([new Uint8Array(16).fill(9)], 'close'),
            });
        });

        const stream = createResilientDownloadStream({
            firstResponse: fakeResponse({
                headers: { 'Content-Length': '32' },
                body: makeBody([new Uint8Array(16).fill(4)], 'error'),
            }),
            expectedTotal: 32,
            getRequest: async () => ({ url: 'https://obj.example/file' }),
            retryDelays: [1],
            maxRetries: 3,
        });

        const out = await readAll(stream);
        expect(out.length).toBe(32);
        expect(resumeAttempts).toBe(1);
    });

    it('gives up permanently on a 410 without burning the retry budget', async () => {
        let attempts = 0;
        installFetch(() => {
            attempts++;
            return fakeResponse({ status: 410 });
        });

        const stream = createResilientDownloadStream({
            getRequest: async () => ({ url: 'https://obj.example/file' }),
            retryDelays: [1],
            maxRetries: 5,
        });

        await expect(readAll(stream)).rejects.toThrow(/HTTP 410/);
        expect(attempts).toBe(1);
    });
});
