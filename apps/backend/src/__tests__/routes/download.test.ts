import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { FileMetadata } from '../../storage';

// ---------------------------------------------------------------------------
// Mocks — must be registered BEFORE any module that transitively imports them
// ---------------------------------------------------------------------------

const mockRedis = {
    ping: mock(() => Promise.resolve(true)),
    hSet: mock(() => Promise.resolve()),
    hGet: mock(() => Promise.resolve(null as string | null)),
    hGetAll: mock(() => Promise.resolve(null as Record<string, string> | null)),
    hDel: mock(() => Promise.resolve()),
    expire: mock(() => Promise.resolve()),
    del: mock(() => Promise.resolve()),
    exists: mock(() => Promise.resolve(false)),
    ttl: mock(() => Promise.resolve(-1)),
    hIncrBy: mock(() => Promise.resolve(0)),
};

const mockStorage = {
    redis: mockRedis,
    ping: mock(() => Promise.resolve({ redis: true, s3: true })),
    getMetadata: mock(() => Promise.resolve(null as FileMetadata | null)),
    setField: mock(() => Promise.resolve()),
    getField: mock(() => Promise.resolve(null as string | null)),
    exists: mock(() => Promise.resolve(false)),
    del: mock(() => Promise.resolve()),
    incrementDownloadCount: mock(() => Promise.resolve(1)),
    getTTL: mock(() => Promise.resolve(86400)),
    getSignedUploadUrl: mock(() =>
        Promise.resolve('https://s3.example.com/upload?signed=true' as string | null),
    ),
    getSignedDownloadUrl: mock(() =>
        Promise.resolve('https://s3.example.com/download?signed=true' as string | null),
    ),
    createMultipartUpload: mock(() => Promise.resolve('test-upload-id' as string | null)),
    getSignedMultipartUploadUrl: mock(() =>
        Promise.resolve('https://s3.example.com/part?signed=true'),
    ),
    completeMultipartUpload: mock(() => Promise.resolve()),
    abortMultipartUpload: mock(() => Promise.resolve()),
    getStream: mock(() => Promise.resolve(null as ReadableStream<Uint8Array> | null)),
    length: mock(() => Promise.resolve(0)),
};

mock.module('../../storage', () => ({ storage: mockStorage }));
mock.module('../../storage/index', () => ({ storage: mockStorage }));
mock.module('../../storage/redis', () => ({ redis: mockRedis, RedisStorage: class {} }));
mock.module('../../storage/s3', () => ({
    s3Storage: {
        ping: mock(() => Promise.resolve(true)),
        del: mock(() => Promise.resolve()),
        getSignedUploadUrl: mock(() =>
            Promise.resolve('https://s3.example.com/upload?signed=true'),
        ),
        getSignedDownloadUrl: mock(() =>
            Promise.resolve('https://s3.example.com/download?signed=true'),
        ),
        createMultipartUpload: mock(() => Promise.resolve('test-upload-id')),
        getSignedMultipartUploadUrl: mock(() =>
            Promise.resolve('https://s3.example.com/part?signed=true'),
        ),
        completeMultipartUpload: mock(() => Promise.resolve()),
        abortMultipartUpload: mock(() => Promise.resolve()),
        getStream: mock(() => Promise.resolve(null)),
        length: mock(() => Promise.resolve(0)),
    },
}));

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

// Mock auth module
const mockVerifyAuth = mock(() => Promise.resolve({ valid: true, nonce: 'test-nonce' }));
const mockVerifyOwner = mock(() => Promise.resolve(true));
mock.module('../../middleware/auth', () => ({
    verifyAuth: mockVerifyAuth,
    verifyOwner: mockVerifyOwner,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { Elysia } from 'elysia';
import { config } from '../../config';
import { downloadRoutes, streamContentLength } from '../../routes/download';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
    return new Elysia().use(downloadRoutes);
}

function jsonPost(path: string, body: Record<string, unknown>) {
    return new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * Build a body stream the way S3Storage.getStream does — optionally tagged with
 * the object's ContentLength so the routes can emit a Content-Length header.
 */
function makeStream(bytes: number[], contentLength?: number) {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            if (bytes.length > 0) {
                controller.enqueue(new Uint8Array(bytes));
            }
            controller.close();
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
        fileSize: 50_000_000,
        metadata: btoa(JSON.stringify({ files: [{ name: 'test-file.txt' }] })),
        auth: 'unencrypted',
        nonce: '',
        uploadId: undefined,
        multipart: false,
        numParts: undefined,
        partSize: undefined,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /download/direct/:id', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.getSignedDownloadUrl.mockReset();
        mockStorage.getSignedDownloadUrl.mockResolvedValue(
            'https://s3.example.com/download?signed=true',
        );
        mockStorage.incrementDownloadCount.mockReset();
        mockStorage.incrementDownloadCount.mockResolvedValue(1);
        mockStorage.del.mockReset();
        mockStorage.del.mockResolvedValue(undefined);
        mockStorage.setField.mockReset();
        mockStorage.setField.mockResolvedValue(undefined);
        mockStorage.getTTL.mockReset();
        mockStorage.getTTL.mockResolvedValue(86400);
    });

    it('should redirect (302) for unencrypted file', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('https://s3.example.com/download?signed=true');
    });

    it('should return 400 for encrypted file', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: true }));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Direct download not available for encrypted files');
    });

    it('should return 404 when file not found', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/nonexistent'));

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });

    it('should return 410 when download limit already reached', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 10, dlimit: 10 }));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.error).toContain('Download limit reached');
    });

    it('should increment download counter via incrementDownloadCount', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 0, dlimit: 10 }));
        mockStorage.incrementDownloadCount.mockResolvedValue(1);

        const app = createApp();
        await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(mockStorage.incrementDownloadCount.mock.calls.length).toBe(1);
        expect(mockStorage.incrementDownloadCount.mock.calls[0][0]).toBe('abc123');
    });

    it('should return 500 when signed URL generation fails without burning a download credit', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 0, dlimit: 10 }));
        mockStorage.getSignedDownloadUrl.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toContain('Failed to generate download URL');
        // Signing happens BEFORE incrementing — the counter must be untouched
        expect(mockStorage.incrementDownloadCount.mock.calls.length).toBe(0);
    });

    it('should cap metadata TTL as a backstop when scheduling deletion at the limit', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 9, dlimit: 10 }));
        mockStorage.incrementDownloadCount.mockResolvedValue(10);
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(302);
        expect(mockRedis.expire).toHaveBeenCalledWith('abc123', 300);
    });

    it('should return 410 when incremented counter exceeds limit', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 9, dlimit: 10 }));
        // After increment, dl becomes 11 which exceeds dlimit of 10
        mockStorage.incrementDownloadCount.mockResolvedValue(11);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.error).toContain('Download limit reached');
    });

    // --- #51: the TTL-cap chain must complete before the response returns ---

    it('should persist expiresAt and cap the TTL BEFORE responding at the limit', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 9, dlimit: 10 }));
        mockStorage.incrementDownloadCount.mockResolvedValue(10);
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);
        // Give the TTL lookup a real (macrotask) latency so an un-awaited chain
        // is demonstrably still pending when the handler returns
        mockStorage.getTTL.mockReset();
        mockStorage.getTTL.mockImplementation(
            () => new Promise<number>((resolve) => setTimeout(() => resolve(86400), 5)),
        );

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(302);
        // A /params raise racing this response must be able to observe
        // expiresAt; pre-fix the chain was fire-and-forget and had not run yet,
        // so /params skipped the TTL restore and the metadata expired at ~300s
        // while the grace timer preserved the object (orphaning it in S3).
        const expiresAtCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[0] === 'abc123' && call[1] === 'expiresAt',
        );
        expect(expiresAtCalls.length).toBe(1);
        expect(parseInt(expiresAtCalls[0][2] as string, 10)).toBeGreaterThan(
            Math.floor(Date.now() / 1000),
        );
        expect(mockRedis.expire).toHaveBeenCalledWith('abc123', 300);
    });

    it('should not cap the TTL when the natural expiry is already inside the grace window', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 9, dlimit: 10 }));
        mockStorage.incrementDownloadCount.mockResolvedValue(10);
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);
        mockStorage.getTTL.mockReset();
        mockStorage.getTTL.mockResolvedValue(120);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(302);
        const expiresAtCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'expiresAt',
        );
        expect(expiresAtCalls.length).toBe(0);
        expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('should still respond 302 when the TTL-cap chain fails', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 9, dlimit: 10 }));
        mockStorage.incrementDownloadCount.mockResolvedValue(10);
        mockStorage.getTTL.mockReset();
        mockStorage.getTTL.mockImplementation(() => Promise.reject(new Error('redis down')));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(302);
    });
});

describe('GET /download/url/:id', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.getSignedDownloadUrl.mockReset();
        mockStorage.getSignedDownloadUrl.mockResolvedValue(
            'https://s3.example.com/download?signed=true',
        );
        mockVerifyAuth.mockReset();
        mockVerifyAuth.mockResolvedValue({ valid: true, nonce: 'test-nonce' });
    });

    it('should return signed URL for unencrypted file', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 2, dlimit: 10 }),
        );

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/url/abc123'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.useSignedUrl).toBe(true);
        expect(body.url).toBe('https://s3.example.com/download?signed=true');
        expect(body.dl).toBe(2);
        expect(body.dlimit).toBe(10);
    });

    it('should return 401 for encrypted file without authorization', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: true }));
        mockVerifyAuth.mockResolvedValue({ valid: false, nonce: 'new-nonce' });

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/url/abc123'));

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('Authentication required');
        expect(res.headers.get('WWW-Authenticate')).toContain('send-v1');
    });

    it('should return signed URL for encrypted file with valid auth', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: true, dl: 0, dlimit: 5 }),
        );
        mockVerifyAuth.mockResolvedValue({ valid: true, nonce: 'new-nonce' });

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/url/abc123', {
                headers: { Authorization: 'send-v1 valid-signature' },
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.useSignedUrl).toBe(true);
        expect(body.url).toBe('https://s3.example.com/download?signed=true');
    });

    it('should return 404 when file not found', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/url/nonexistent'));

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });

    it('should return useSignedUrl=false when signed URL generation fails', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 1, dlimit: 10 }),
        );
        mockStorage.getSignedDownloadUrl.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/url/abc123'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.useSignedUrl).toBe(false);
        expect(body.dl).toBe(1);
        expect(body.dlimit).toBe(10);
    });

    it('should return 200 with counts and no URL when download limit is reached', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 10, dlimit: 10 }),
        );

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/url/abc123'));

        // Soft response: old and new frontends both gate on dl >= dlimit
        // themselves; a 410 here would read as "status unknown" to old clients
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.useSignedUrl).toBe(false);
        expect(body.url).toBeUndefined();
        expect(body.dl).toBe(10);
        expect(body.dlimit).toBe(10);
        expect(mockStorage.getSignedDownloadUrl.mock.calls.length).toBe(0);
    });

    it('should return 401 (not 410) for unauthenticated encrypted file at the limit', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: true, dl: 10, dlimit: 10 }),
        );
        mockVerifyAuth.mockResolvedValue({ valid: false, nonce: 'challenge-nonce' });

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/url/abc123'));

        // Auth (and the WWW-Authenticate nonce flow) runs before the limit gate
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toContain('send-v1');
    });
});

describe('GET /download/:id (stream)', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.getStream.mockReset();
        mockStorage.getStream.mockResolvedValue(null);
        mockVerifyAuth.mockReset();
        mockVerifyAuth.mockResolvedValue({ valid: true, nonce: 'test-nonce' });
    });

    it('should return 410 when download limit is reached', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 10, dlimit: 10 }),
        );

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/abc123'));

        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.error).toContain('Download limit reached');
        expect(mockStorage.getStream.mock.calls.length).toBe(0);
    });

    it('should stream the file when under the limit', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.getStream.mockResolvedValue(makeStream([1, 2, 3]));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/abc123'));

        expect(res.status).toBe(200);
    });

    // --- #26: a missing S3 object must surface as 404, not 500 ---

    it('should return 404 when the object is gone from the bucket', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.getStream.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/abc123'));

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });

    // --- #39: Content-Length must be emitted so the client truncation guard fires ---

    it('should emit Content-Length from the stream ContentLength tag', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.getStream.mockResolvedValue(makeStream([1, 2, 3], 3));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/abc123'));

        expect(res.status).toBe(200);
        // Pre-fix the response was chunked with no Content-Length, so the
        // client read contentLength === 0 and skipped its only hard truncation
        // check — a severed transfer was saved as a complete file.
        expect(res.headers.get('content-length')).toBe('3');
    });

    it('should emit Content-Length: 0 for a zero-byte object', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.getStream.mockResolvedValue(makeStream([], 0));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/abc123'));

        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe('0');
    });

    it('should omit Content-Length when the storage layer reports no length', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.getStream.mockResolvedValue(makeStream([1, 2, 3]));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/abc123'));

        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBeNull();
    });
});

describe('streamContentLength (#39)', () => {
    it('reads the ContentLength tag attached by the storage layer', () => {
        expect(streamContentLength(makeStream([1, 2, 3], 3))).toBe(3);
        expect(streamContentLength(makeStream([], 0))).toBe(0);
    });

    it('returns undefined for an untagged or nonsensical tag', () => {
        expect(streamContentLength(makeStream([1]))).toBeUndefined();
        expect(
            streamContentLength(
                Object.assign(makeStream([1]), { contentLength: -1 }) as ReadableStream<Uint8Array>,
            ),
        ).toBeUndefined();
        expect(
            streamContentLength(
                Object.assign(makeStream([1]), {
                    contentLength: 'nope',
                }) as unknown as ReadableStream<Uint8Array>,
            ),
        ).toBeUndefined();
        expect(
            streamContentLength(
                Object.assign(makeStream([1]), {
                    contentLength: Number.NaN,
                }) as ReadableStream<Uint8Array>,
            ),
        ).toBeUndefined();
    });
});

describe('GET /download/blob/:id', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.getStream.mockReset();
        mockStorage.getStream.mockResolvedValue(null);
        mockVerifyAuth.mockReset();
        mockVerifyAuth.mockResolvedValue({ valid: true, nonce: 'test-nonce' });
    });

    it('should return 410 when download limit is reached', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 10, dlimit: 10 }),
        );

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/blob/abc123'));

        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.error).toContain('Download limit reached');
        expect(mockStorage.getStream.mock.calls.length).toBe(0);
    });

    it('should return 404 when the object is gone from the bucket (#26)', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.getStream.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/blob/abc123'));

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });

    it('should emit Content-Length from the stream ContentLength tag (#39)', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.getStream.mockResolvedValue(makeStream([1, 2, 3, 4], 4));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/blob/abc123'));

        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe('4');
    });

    it('should omit Content-Length when the storage layer reports no length (#39)', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.getStream.mockResolvedValue(makeStream([1, 2, 3, 4]));

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/blob/abc123'));

        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBeNull();
    });
});

describe('POST /download/complete/:id', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.incrementDownloadCount.mockReset();
        mockStorage.incrementDownloadCount.mockResolvedValue(1);
        mockStorage.del.mockReset();
        mockStorage.del.mockResolvedValue(undefined);
        mockStorage.getField.mockReset();
        mockStorage.getField.mockResolvedValue(null);
        mockVerifyAuth.mockReset();
        mockVerifyAuth.mockResolvedValue({ valid: true, nonce: 'test-nonce' });
    });

    it('should increment counter and return deleted=false for unencrypted file', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.incrementDownloadCount.mockResolvedValue(1);

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', { method: 'POST' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.deleted).toBe(false);
        expect(body.dl).toBe(1);
        expect(body.dlimit).toBe(10);

        expect(mockStorage.incrementDownloadCount.mock.calls.length).toBe(1);
        expect(mockStorage.del.mock.calls.length).toBe(0);
    });

    it('should delete file when counter reaches limit', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 9, dlimit: 10 }),
        );
        mockStorage.incrementDownloadCount.mockResolvedValue(10);
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', { method: 'POST' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.deleted).toBe(true);
        expect(body.dl).toBe(10);
        expect(body.dlimit).toBe(10);

        expect(mockStorage.del.mock.calls.length).toBe(1);
        // TTL backstop caps consumed metadata if the delete failed
        expect(mockRedis.expire).toHaveBeenCalledWith('abc123', 300);
    });

    it('should return 404 when file not found', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/nonexistent', { method: 'POST' }),
        );

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });

    it('should return 401 for encrypted file without auth', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: true }));
        mockVerifyAuth.mockResolvedValue({ valid: false, nonce: 'new-nonce' });

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', { method: 'POST' }),
        );

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('Authentication required');
    });

    it('should succeed for encrypted file with valid auth', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: true, dl: 0, dlimit: 10 }),
        );
        mockVerifyAuth.mockResolvedValue({ valid: true, nonce: 'new-nonce' });
        mockStorage.incrementDownloadCount.mockResolvedValue(1);

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', {
                method: 'POST',
                headers: { Authorization: 'send-v1 valid-signature' },
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.deleted).toBe(false);
        expect(body.dl).toBe(1);
    });

    // --- #25: never delete against a stale dlimit snapshot ---

    it('should NOT delete when the owner raised dlimit after the initial read', async () => {
        // Snapshot at request start: dl=0, dlimit=1
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 1 }),
        );
        mockStorage.incrementDownloadCount.mockResolvedValue(1);
        // Meanwhile the owner raised the limit to 20 via /params
        mockStorage.getField.mockResolvedValue('20');
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', { method: 'POST' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        // Pre-fix this compared 1 >= 1 against the stale snapshot and
        // permanently destroyed the object + metadata the owner had just
        // re-enabled.
        expect(body.deleted).toBe(false);
        expect(body.dl).toBe(1);
        expect(body.dlimit).toBe(20);
        expect(mockStorage.del.mock.calls.length).toBe(0);
        expect(mockRedis.expire).not.toHaveBeenCalled();
        expect(mockStorage.getField).toHaveBeenCalledWith('abc123', 'dlimit');
    });

    it('should delete when the owner LOWERED dlimit after the initial read', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.incrementDownloadCount.mockResolvedValue(1);
        mockStorage.getField.mockResolvedValue('1');
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', { method: 'POST' }),
        );

        const body = await res.json();
        expect(body.deleted).toBe(true);
        expect(body.dlimit).toBe(1);
        expect(mockStorage.del.mock.calls.length).toBe(1);
    });

    it('should fall back to the snapshot limit when the re-read returns nothing', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 9, dlimit: 10 }),
        );
        mockStorage.incrementDownloadCount.mockResolvedValue(10);
        mockStorage.getField.mockResolvedValue(null);
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', { method: 'POST' }),
        );

        const body = await res.json();
        expect(body.deleted).toBe(true);
        expect(body.dlimit).toBe(10);
        expect(mockStorage.del.mock.calls.length).toBe(1);
    });

    it('should fall back to the snapshot limit when the re-read is unparseable', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 9, dlimit: 10 }),
        );
        mockStorage.incrementDownloadCount.mockResolvedValue(10);
        mockStorage.getField.mockResolvedValue('not-a-number');

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', { method: 'POST' }),
        );

        const body = await res.json();
        expect(body.deleted).toBe(true);
        expect(body.dlimit).toBe(10);
    });

    it('should fall back to the snapshot limit when the re-read throws', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, dl: 0, dlimit: 10 }),
        );
        mockStorage.incrementDownloadCount.mockResolvedValue(1);
        mockStorage.getField.mockImplementation(() => Promise.reject(new Error('redis down')));

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/download/complete/abc123', { method: 'POST' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.deleted).toBe(false);
        expect(body.dlimit).toBe(10);
    });
});

describe('GET /metadata/:id', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.getTTL.mockReset();
        mockStorage.getTTL.mockResolvedValue(86400);
        mockVerifyAuth.mockReset();
        mockVerifyAuth.mockResolvedValue({ valid: true, nonce: 'test-nonce' });
    });

    it('should return metadata for unencrypted file', async () => {
        const testMetadata = btoa(JSON.stringify({ files: [{ name: 'report.pdf' }] }));
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, metadata: testMetadata }),
        );

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/metadata/abc123'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.metadata).toBe(testMetadata);
        expect(body.ttl).toBe(86400);
        expect(body.encrypted).toBe(false);
    });

    it('should return metadata for encrypted file with valid auth', async () => {
        const testMetadata = btoa(JSON.stringify({ files: [{ name: 'secret.pdf' }] }));
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: true, metadata: testMetadata }),
        );
        mockVerifyAuth.mockResolvedValue({ valid: true, nonce: 'new-nonce' });

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/metadata/abc123', {
                headers: { Authorization: 'send-v1 valid-signature' },
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.metadata).toBe(testMetadata);
        expect(body.encrypted).toBe(true);
    });

    it('should return 401 for encrypted file without auth', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: true }));
        mockVerifyAuth.mockResolvedValue({ valid: false, nonce: 'new-nonce' });

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/metadata/abc123'));

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('Authentication required');
        expect(res.headers.get('WWW-Authenticate')).toContain('send-v1');
    });

    it('should return 404 when file not found', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/metadata/nonexistent'));

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });

    it('should return empty string for metadata when none is stored', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, metadata: undefined }),
        );

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/metadata/abc123'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.metadata).toBe('');
    });
});

describe('GET /exists/:id', () => {
    beforeEach(() => {
        mockStorage.exists.mockReset();
    });

    it('should return { exists: true } when file exists', async () => {
        mockStorage.exists.mockResolvedValue(true);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/exists/abc123'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.exists).toBe(true);
    });

    it('should return { exists: false } when file does not exist', async () => {
        mockStorage.exists.mockResolvedValue(false);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/exists/nonexistent'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.exists).toBe(false);
    });
});

describe('POST /delete/:id', () => {
    beforeEach(() => {
        mockVerifyOwner.mockReset();
        mockVerifyOwner.mockResolvedValue(true);
        mockStorage.del.mockReset();
        mockStorage.del.mockResolvedValue(undefined);
    });

    it('should delete file for valid owner', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/delete/abc123', { owner_token: 'valid-owner-token' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        expect(mockStorage.del.mock.calls.length).toBe(1);
        expect(mockStorage.del.mock.calls[0][0]).toBe('abc123');
        expect(mockVerifyOwner.mock.calls[0][0]).toBe('abc123');
        expect(mockVerifyOwner.mock.calls[0][1]).toBe('valid-owner-token');
    });

    it('should return 401 for invalid owner', async () => {
        mockVerifyOwner.mockResolvedValue(false);

        const app = createApp();
        const res = await app.handle(jsonPost('/delete/abc123', { owner_token: 'wrong-token' }));

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('Invalid owner token');
        expect(mockStorage.del.mock.calls.length).toBe(0);
    });
});

describe('POST /params/:id', () => {
    beforeEach(() => {
        mockVerifyOwner.mockReset();
        mockVerifyOwner.mockResolvedValue(true);
        mockStorage.setField.mockReset();
        mockStorage.setField.mockResolvedValue(undefined);
        mockStorage.getMetadata.mockReset();
        mockStorage.getMetadata.mockResolvedValue(null);
        mockStorage.getField.mockReset();
        mockStorage.getField.mockResolvedValue(null);
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);
        mockRedis.hDel.mockReset();
        mockRedis.hDel.mockResolvedValue(undefined);
    });

    function storedDlimit(): string | undefined {
        const call = mockStorage.setField.mock.calls.find(
            (c: unknown[]) => c[1] === 'dlimit',
        ) as unknown as [string, string, string] | undefined;
        return call?.[2];
    }

    it('should update dlimit for valid owner', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/params/abc123', { owner_token: 'valid-owner-token', dlimit: 50 }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // Should have called setField with the new dlimit
        const dlimitCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'dlimit' && call[2] === '50',
        );
        expect(dlimitCalls.length).toBe(1);
    });

    it('should return 401 for invalid owner', async () => {
        mockVerifyOwner.mockResolvedValue(false);

        const app = createApp();
        const res = await app.handle(
            jsonPost('/params/abc123', { owner_token: 'wrong-token', dlimit: 50 }),
        );

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('Invalid owner token');
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should succeed without dlimit (no field update)', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/params/abc123', { owner_token: 'valid-owner-token' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // setField should not have been called for dlimit
        const dlimitCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'dlimit',
        );
        expect(dlimitCalls.length).toBe(0);
    });

    // --- #5: dlimit must be validated and clamped, exactly as at creation ---

    it('should clamp an unbounded dlimit down to config.maxDownloads', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/params/abc123', {
                owner_token: 'valid-owner-token',
                dlimit: 1_000_000_000,
            }),
        );

        expect(res.status).toBe(200);
        // Pre-fix this stored '1000000000' verbatim, making every
        // `dl >= dlimit` gate unreachable — effectively unlimited egress.
        expect(storedDlimit()).toBe(String(config.maxDownloads));
    });

    it('should reject a zero or negative dlimit at the schema boundary', async () => {
        const app = createApp();

        for (const dlimit of [0, -1, -1_000_000]) {
            mockStorage.setField.mockReset();
            const res = await app.handle(
                jsonPost('/params/abc123', { owner_token: 'valid-owner-token', dlimit }),
            );

            // Pre-fix a bare t.Number() accepted these and stored them verbatim;
            // `-1` survives `||` and instantly bricks the file.
            expect(res.status).toBe(422);
            expect(mockStorage.setField.mock.calls.length).toBe(0);
        }
    });

    it('should reject a fractional dlimit at the schema boundary', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/params/abc123', { owner_token: 'valid-owner-token', dlimit: 2.5 }),
        );

        expect(res.status).toBe(422);
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should never store a dlimit in exponential notation', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/params/abc123', { owner_token: 'valid-owner-token', dlimit: 1e21 }),
        );

        expect(res.status).toBe(200);
        const stored = storedDlimit();
        // `String(1e21)` is '1e+21', which parseInt reads back as 1 —
        // a silent single-use self-destruct.
        expect(stored).not.toContain('e');
        expect(parseInt(stored as string, 10)).toBe(config.maxDownloads);
    });

    it('should restore the capped TTL against the CLAMPED limit, not the raw request', async () => {
        // dl is above config.maxDownloads, so a clamped raise cannot re-enable
        // the file and the TTL backstop must stay in place
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ dl: config.maxDownloads + 5, dlimit: 1 }),
        );
        mockStorage.getField.mockResolvedValue(String(Math.floor(Date.now() / 1000) + 86400));

        const app = createApp();
        const res = await app.handle(
            jsonPost('/params/abc123', {
                owner_token: 'valid-owner-token',
                dlimit: 1_000_000_000,
            }),
        );

        expect(res.status).toBe(200);
        expect(mockRedis.expire).not.toHaveBeenCalled();
        expect(mockRedis.hDel).not.toHaveBeenCalled();
    });

    it('should restore the original expiry when a valid raise re-enables the file', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 1, dlimit: 1 }));
        mockStorage.getField.mockResolvedValue(String(Math.floor(Date.now() / 1000) + 86400));

        const app = createApp();
        const res = await app.handle(
            jsonPost('/params/abc123', { owner_token: 'valid-owner-token', dlimit: 5 }),
        );

        expect(res.status).toBe(200);
        expect(storedDlimit()).toBe('5');
        expect(mockRedis.expire.mock.calls.length).toBe(1);
        expect(mockRedis.hDel).toHaveBeenCalledWith('abc123', 'expiresAt');
    });
});

describe('POST /info/:id', () => {
    beforeEach(() => {
        mockVerifyOwner.mockReset();
        mockVerifyOwner.mockResolvedValue(true);
        mockStorage.getMetadata.mockReset();
        mockStorage.getTTL.mockReset();
        mockStorage.getTTL.mockResolvedValue(86400);
    });

    it('should return dl, dlimit, and ttl for valid owner', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 3, dlimit: 20 }));

        const app = createApp();
        const res = await app.handle(
            jsonPost('/info/abc123', { owner_token: 'valid-owner-token' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.dl).toBe(3);
        expect(body.dlimit).toBe(20);
        expect(body.ttl).toBe(86400);
    });

    it('should return 401 for invalid owner', async () => {
        mockVerifyOwner.mockResolvedValue(false);

        const app = createApp();
        const res = await app.handle(jsonPost('/info/abc123', { owner_token: 'wrong-token' }));

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('Invalid owner token');
    });

    it('should return 404 when file not found after owner check', async () => {
        // verifyOwner passes but getMetadata returns null (edge case: race condition)
        mockVerifyOwner.mockResolvedValue(true);
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(
            jsonPost('/info/abc123', { owner_token: 'valid-owner-token' }),
        );

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });
});

describe('POST /password/:id', () => {
    beforeEach(() => {
        mockVerifyOwner.mockReset();
        mockVerifyOwner.mockResolvedValue(true);
        mockStorage.setField.mockReset();
        mockStorage.setField.mockResolvedValue(undefined);
        mockStorage.getMetadata.mockReset();
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: true }));
    });

    it('should set auth field for valid owner of an encrypted file', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/password/abc123', {
                owner_token: 'valid-owner-token',
                auth: 'new-password-hash',
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // setField should be called with the new auth value
        const authCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) =>
                call[0] === 'abc123' && call[1] === 'auth' && call[2] === 'new-password-hash',
        );
        expect(authCalls.length).toBe(1);
    });

    it('should return 401 for invalid owner', async () => {
        mockVerifyOwner.mockResolvedValue(false);

        const app = createApp();
        const res = await app.handle(
            jsonPost('/password/abc123', {
                owner_token: 'wrong-token',
                auth: 'new-password-hash',
            }),
        );

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('Invalid owner token');
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should return 400 for unencrypted files without touching auth', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));

        const app = createApp();
        const res = await app.handle(
            jsonPost('/password/abc123', {
                owner_token: 'valid-owner-token',
                auth: 'new-password-hash',
            }),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('only supported for encrypted files');
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should return 400 when metadata is missing', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(
            jsonPost('/password/abc123', {
                owner_token: 'valid-owner-token',
                auth: 'new-password-hash',
            }),
        );

        expect(res.status).toBe(400);
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });
});
