/**
 * #39 — wire-level regression test for the fallback stream routes.
 *
 * These assertions have to cross a real socket. `app.handle(request)` returns an
 * in-process `Response` that never touches Bun's HTTP serialiser, so it happily
 * reports a `Content-Length` that the server would strip, and it hides the fact
 * that a bare `ReadableStream` return value gets JSON-serialised on the way out.
 * Both bugs are only observable through `Bun.serve` + `fetch`.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { FileMetadata } from '../../storage';

// ---------------------------------------------------------------------------
// Mocks — must be registered BEFORE any module that transitively imports them
// ---------------------------------------------------------------------------

const mockRedis = {
    expire: mock(() => Promise.resolve()),
    hDel: mock(() => Promise.resolve()),
    capTTLAtDownloadLimit: mock(() => Promise.resolve(true)),
};

const mockStorage = {
    redis: mockRedis,
    getMetadata: mock(() => Promise.resolve(null as FileMetadata | null)),
    getStream: mock(() => Promise.resolve(null as ReadableStream<Uint8Array> | null)),
    getField: mock(() => Promise.resolve(null as string | null)),
    setField: mock(() => Promise.resolve()),
    del: mock(() => Promise.resolve()),
    incrementDownloadCount: mock(() => Promise.resolve(1)),
    getTTL: mock(() => Promise.resolve(86400)),
    getSignedDownloadUrl: mock(() => Promise.resolve('https://s3.example.com/dl' as string | null)),
    exists: mock(() => Promise.resolve(true)),
};

mock.module('../../storage', () => ({ storage: mockStorage }));
mock.module('../../storage/index', () => ({ storage: mockStorage }));

mock.module('../../lib/sentry', () => ({
    captureError: mock(() => {
        /* noop */
    }),
    addBreadcrumb: mock(() => {
        /* noop */
    }),
}));

const noopLogger = {
    info: () => {
        /* noop */
    },
    warn: () => {
        /* noop */
    },
    error: () => {
        /* noop */
    },
    debug: () => {
        /* noop */
    },
    child: () => noopLogger,
};
mock.module('../../logger', () => ({
    logger: noopLogger,
    uploadLogger: noopLogger,
    downloadLogger: noopLogger,
    storageLogger: noopLogger,
    s3Logger: noopLogger,
}));

mock.module('../../middleware/auth', () => ({
    verifyAuth: mock(() => Promise.resolve({ valid: true, nonce: 'test-nonce' })),
    verifyOwner: mock(() => Promise.resolve(true)),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { serve } from 'bun';
import { Elysia } from 'elysia';
import { downloadRoutes, OBJECT_CONTENT_LENGTH_HEADER } from '../../routes/download';

// ---------------------------------------------------------------------------
// A real server on a real port
// ---------------------------------------------------------------------------

const app = new Elysia().use(downloadRoutes);
const server = serve({ port: 0, fetch: app.handle });
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
    server.stop(true);
});

const CHUNK = 65_536;
const CHUNKS = 4;
const TOTAL = CHUNK * CHUNKS;

/** Multi-chunk body, tagged the way S3Storage.getStream tags it. */
function taggedStream(contentLength?: number) {
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (emitted >= CHUNKS) {
                controller.close();
                return;
            }
            controller.enqueue(new Uint8Array(CHUNK).fill(7));
            emitted++;
        },
    });
    return contentLength === undefined ? stream : Object.assign(stream, { contentLength });
}

function makeMetadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
    return {
        id: 'abc123',
        prefix: '1',
        owner: 'owner-token',
        encrypted: false,
        dl: 0,
        dlimit: 10,
        fileSize: TOTAL,
        metadata: btoa(JSON.stringify({ files: [{ name: 'test-file.bin' }] })),
        auth: 'unencrypted',
        nonce: '',
        uploadId: undefined,
        multipart: false,
        numParts: undefined,
        partSize: undefined,
        ...overrides,
    };
}

describe.each([
    ['GET /download/:id', '/download/abc123'],
    ['GET /download/blob/:id', '/download/blob/abc123'],
])('%s over a real Bun.serve round trip (#39)', (_name, path) => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.getMetadata.mockResolvedValue(makeMetadata());
        mockStorage.getStream.mockReset();
    });

    it('advertises the object length in a header that survives Bun serialisation', async () => {
        mockStorage.getStream.mockResolvedValue(taggedStream(TOTAL));

        const res = await fetch(BASE + path);

        expect(res.status).toBe(200);
        // The client's only hard truncation guard compares received bytes
        // against this. Bun forces `transfer-encoding: chunked` for every
        // streamed body and drops an explicit Content-Length, so a route that
        // relies on Content-Length alone leaves the guard permanently disabled.
        expect(res.headers.get(OBJECT_CONTENT_LENGTH_HEADER)).toBe(String(TOTAL));
    });

    it('returns the raw object bytes, not a JSON-serialised chunk array', async () => {
        mockStorage.getStream.mockResolvedValue(taggedStream(TOTAL));

        const res = await fetch(BASE + path);
        const body = new Uint8Array(await res.arrayBuffer());

        // Returning a bare ReadableStream routes through Elysia's handleStream,
        // which JSON.stringify()s each Uint8Array chunk: this body came back as
        // ~2.5MB of `{"0":7,"1":7,...}` text with a
        // `application/octet-stream, text/plain` content type.
        expect(body.length).toBe(TOTAL);
        expect(body[0]).toBe(7);
        expect(body[TOTAL - 1]).toBe(7);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('omits the length header when the storage layer reports no length', async () => {
        mockStorage.getStream.mockResolvedValue(taggedStream());

        const res = await fetch(BASE + path);
        const body = new Uint8Array(await res.arrayBuffer());

        expect(res.status).toBe(200);
        expect(res.headers.get(OBJECT_CONTENT_LENGTH_HEADER)).toBeNull();
        // Still binary, still complete — only the guard is unavailable
        expect(body.length).toBe(TOTAL);
    });

    it('still returns 404 JSON when the object is gone from the bucket', async () => {
        mockStorage.getStream.mockResolvedValue(null);

        const res = await fetch(BASE + path);

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'File not found' });
    });
});
