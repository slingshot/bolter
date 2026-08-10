/**
 * Follow-ups to the 9 Aug 2026 audit:
 *  #15 — the server starts the metadata TTL at /upload/url, not at completion,
 *        so the client must use the server's own expiry rather than computing
 *        `Date.now() + timeLimit` when the upload finishes.
 *  #52 — /upload/abort and /upload/multipart/:id/resume are authorized by an
 *        upload-owner token; without the client sending it, the backend's
 *        verification can never be switched on.
 */
import { describe, expect, it, vi } from 'vitest';
import { readCompletionLifetime } from '@/lib/api';
import { abortServerMultipart } from '@/lib/multipart-abort';

function jsonResponse(body: unknown): Response {
    return { json: () => Promise.resolve(body) } as unknown as Response;
}

describe('readCompletionLifetime (#15)', () => {
    it('takes the authoritative expiry from the completion response', async () => {
        const expiresAt = 1_800_000_000_000;
        await expect(
            readCompletionLifetime(jsonResponse({ success: true, expiresAt, ttl: 10_800 })),
        ).resolves.toEqual({ expiresAt, ttl: 10_800 });
    });

    it('reports nothing when an older backend omits the fields', async () => {
        // Must not invent values — the caller falls back to its own estimate.
        await expect(readCompletionLifetime(jsonResponse({ success: true }))).resolves.toEqual({
            expiresAt: undefined,
            ttl: undefined,
        });
    });

    it('ignores non-numeric values rather than propagating junk', async () => {
        await expect(
            readCompletionLifetime(jsonResponse({ expiresAt: 'soon', ttl: null })),
        ).resolves.toEqual({ expiresAt: undefined, ttl: undefined });
    });

    it('never fails an already-finalized upload on an unreadable body', async () => {
        const broken = { json: () => Promise.reject(new Error('bad json')) } as unknown as Response;
        await expect(readCompletionLifetime(broken)).resolves.toEqual({});
        await expect(readCompletionLifetime(jsonResponse(null))).resolves.toEqual({});
    });
});

describe('abortServerMultipart upload token (#52)', () => {
    function installFetch(capture: { body?: Record<string, unknown> }) {
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: unknown, init: { body: string }) => {
                capture.body = JSON.parse(init.body);
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true }),
                } as unknown as Response);
            }),
        );
    }

    it('sends the upload token so the abort can be authorized', async () => {
        const capture: { body?: Record<string, unknown> } = {};
        installFetch(capture);

        await expect(abortServerMultipart('file-1', 'upload-1', 'tok-abc')).resolves.toBe(true);

        expect(capture.body).toEqual({ uploadId: 'upload-1', uploadToken: 'tok-abc' });
        vi.unstubAllGlobals();
    });

    it('omits the token entirely for records persisted before it existed', async () => {
        // Sending `uploadToken: undefined` would serialize the key away anyway,
        // but an explicit null/empty would be a different request — pin that the
        // pre-v4 shape is byte-identical to what the old client sent.
        const capture: { body?: Record<string, unknown> } = {};
        installFetch(capture);

        await abortServerMultipart('file-1', 'upload-1');

        expect(capture.body).toEqual({ uploadId: 'upload-1' });
        expect('uploadToken' in (capture.body as object)).toBe(false);
        vi.unstubAllGlobals();
    });
});
