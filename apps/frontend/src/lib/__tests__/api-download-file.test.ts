import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '@/lib/api';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FileEntry {
    name: string;
    size: number;
    type: string;
}

/** `/metadata/:id` shape for an unencrypted share (base64 JSON envelope). */
function metadataResponse(files: FileEntry[]): Response {
    const encoded = btoa(JSON.stringify({ files }));
    return new Response(JSON.stringify({ metadata: encoded, encrypted: false, ttl: 86400 }), {
        status: 200,
    });
}

/** Minimal Response stand-in for the object body — only what downloadFile reads. */
function bodyResponse(bytes: number, headers: Record<string, string> = {}): Response {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (sent) {
                controller.close();
                return;
            }
            sent = true;
            controller.enqueue(new Uint8Array(bytes).fill(5));
        },
    });
    return {
        status: 200,
        ok: true,
        headers: new Headers(headers),
        body,
    } as unknown as Response;
}

describe('downloadFile', () => {
    let calls: string[];

    beforeEach(() => {
        calls = [];
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /**
     * Route by longest-prefix first: '/download/url/' also matches '/download/'.
     */
    function installFetch(routes: {
        metadata: () => Response;
        downloadUrl: () => Response;
        body?: () => Response;
        complete?: () => Response;
    }) {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: unknown) => {
                const u = String(url);
                calls.push(u);
                if (u.includes('/metadata/')) {
                    return Promise.resolve(routes.metadata());
                }
                if (u.includes('/download/url/')) {
                    return Promise.resolve(routes.downloadUrl());
                }
                if (u.includes('/download/complete/')) {
                    return Promise.resolve(
                        routes.complete?.() ??
                            new Response(JSON.stringify({ ok: true }), { status: 200 }),
                    );
                }
                if (u.includes('/download/')) {
                    return Promise.resolve(
                        routes.body?.() ??
                            ({
                                status: 410,
                                ok: false,
                                headers: new Headers(),
                                body: null,
                            } as unknown as Response),
                    );
                }
                return Promise.reject(new Error(`Unexpected fetch: ${u}`));
            }),
        );
    }

    // -----------------------------------------------------------------------
    // Finding 32 — soft 200 at the download limit
    // -----------------------------------------------------------------------

    it('throws LimitReachedError on the at-limit soft 200 (finding 32)', async () => {
        // The backend deliberately answers 200 with the counters at the limit
        // (documented tradeoff) rather than 410. Ignoring them meant falling
        // through to /download/:id, which hard-410s and surfaced as a generic
        // retryable "HTTP 410" with a Try again button and a spurious report.
        installFetch({
            metadata: () =>
                metadataResponse([{ name: 'a.bin', size: 10, type: 'application/octet-stream' }]),
            downloadUrl: () =>
                new Response(JSON.stringify({ useSignedUrl: false, url: '', dl: 3, dlimit: 3 }), {
                    status: 200,
                }),
        });

        await expect(downloadFile('file-id', null)).rejects.toMatchObject({
            name: 'LimitReachedError',
        });
        // Never touched the object route, so no 410/404 noise
        expect(calls.some((c) => c.endsWith('/download/file-id'))).toBe(false);
    });

    it('proceeds normally while downloads remain', async () => {
        installFetch({
            metadata: () =>
                metadataResponse([{ name: 'a.bin', size: 64, type: 'application/octet-stream' }]),
            downloadUrl: () =>
                new Response(JSON.stringify({ useSignedUrl: false, url: '', dl: 1, dlimit: 3 }), {
                    status: 200,
                }),
            body: () => bodyResponse(64, { 'Content-Length': '64' }),
        });

        const result = await downloadFile('file-id', null);
        expect(result.filename).toBe('a.bin');
        expect(result.blob.size).toBe(64);
    });

    it('does not gate when the server omits the counters', async () => {
        // Signed-URL responses carry no dl/dlimit — absence must never be
        // read as "at limit".
        installFetch({
            metadata: () =>
                metadataResponse([{ name: 'a.bin', size: 64, type: 'application/octet-stream' }]),
            downloadUrl: () =>
                new Response(JSON.stringify({ useSignedUrl: false, url: '' }), { status: 200 }),
            body: () => bodyResponse(64, { 'Content-Length': '64' }),
        });

        await expect(downloadFile('file-id', null)).resolves.toMatchObject({ filename: 'a.bin' });
    });

    // -----------------------------------------------------------------------
    // Finding 39 (client half) — no Content-Length on the fallback route
    // -----------------------------------------------------------------------

    it('fails a short download that carries no Content-Length (finding 39)', async () => {
        // The fallback stream route sends no Content-Length, so the only hard
        // truncation guard is skipped. An unencrypted payload has no ECE
        // authentication either, so a severed upstream would otherwise be
        // saved as a corrupt file with a download credit burned.
        installFetch({
            metadata: () =>
                metadataResponse([{ name: 'a.bin', size: 1000, type: 'application/octet-stream' }]),
            downloadUrl: () =>
                new Response(JSON.stringify({ useSignedUrl: false, url: '', dl: 0, dlimit: 5 }), {
                    status: 200,
                }),
            body: () => bodyResponse(400), // truncated, and no Content-Length
        });

        await expect(downloadFile('file-id', null)).rejects.toThrow(
            /Download incomplete: received 400 of 1000 bytes/,
        );
        // The credit must not be burned on a corrupt file
        expect(calls.some((c) => c.includes('/download/complete/'))).toBe(false);
    });

    it('accepts a complete download that carries no Content-Length', async () => {
        installFetch({
            metadata: () =>
                metadataResponse([{ name: 'a.bin', size: 1000, type: 'application/octet-stream' }]),
            downloadUrl: () =>
                new Response(JSON.stringify({ useSignedUrl: false, url: '', dl: 0, dlimit: 5 }), {
                    status: 200,
                }),
            body: () => bodyResponse(1000),
        });

        const result = await downloadFile('file-id', null);
        expect(result.blob.size).toBe(1000);
        expect(calls.some((c) => c.includes('/download/complete/'))).toBe(true);
    });

    it('still fails a short download that does carry Content-Length', async () => {
        installFetch({
            metadata: () =>
                metadataResponse([{ name: 'a.bin', size: 1000, type: 'application/octet-stream' }]),
            downloadUrl: () =>
                new Response(JSON.stringify({ useSignedUrl: false, url: '', dl: 0, dlimit: 5 }), {
                    status: 200,
                }),
            body: () => bodyResponse(400, { 'Content-Length': '1000' }),
        });

        await expect(downloadFile('file-id', null)).rejects.toThrow(/Download incomplete/);
    });
});
