import { describe, expect, it } from 'vitest';
import { advertisedBodyLength } from '@/lib/api';

/**
 * #39 — the fallback stream routes (`GET /download/:id`, `/download/blob/:id`)
 * cannot advertise a real `Content-Length`. Bun serialises every streamed body
 * as `transfer-encoding: chunked` and drops the header no matter how it is set,
 * so a client that only reads `Content-Length` computes 0 for those responses
 * and skips its only hard truncation guard — a transfer severed mid-stream is
 * saved as a complete-looking, corrupt file with a download credit burned.
 *
 * The backend therefore also emits the object's true size (from the S3
 * `GetObject` `ContentLength`) in `X-Object-Content-Length`, which survives Bun
 * and is CORS-exposed. This must be preferred.
 */
function response(headers: Record<string, string>) {
    return new Response(null, { headers });
}

describe('advertisedBodyLength (#39)', () => {
    it('prefers X-Object-Content-Length when Content-Length is absent', () => {
        // Exactly the fallback-stream case: chunked, no Content-Length
        expect(advertisedBodyLength(response({ 'X-Object-Content-Length': '52428800' }))).toBe(
            52428800,
        );
    });

    it('prefers X-Object-Content-Length even when Content-Length is present', () => {
        // The object length from S3 is authoritative; Content-Length can be
        // rewritten by an intermediary that re-frames or compresses the body.
        expect(
            advertisedBodyLength(
                response({ 'X-Object-Content-Length': '100', 'Content-Length': '40' }),
            ),
        ).toBe(100);
    });

    it('falls back to Content-Length for signed-URL downloads straight from S3', () => {
        expect(advertisedBodyLength(response({ 'Content-Length': '2048' }))).toBe(2048);
    });

    it('returns 0 when neither header is present, leaving the guard disabled', () => {
        expect(advertisedBodyLength(response({}))).toBe(0);
    });

    it('treats a zero-byte object as a real length of 0, not an unknown length', () => {
        expect(advertisedBodyLength(response({ 'X-Object-Content-Length': '0' }))).toBe(0);
    });

    it('ignores an unparseable value and falls through to the next header', () => {
        expect(
            advertisedBodyLength(
                response({ 'X-Object-Content-Length': 'nope', 'Content-Length': '77' }),
            ),
        ).toBe(77);
        expect(advertisedBodyLength(response({ 'X-Object-Content-Length': 'nope' }))).toBe(0);
    });
});
