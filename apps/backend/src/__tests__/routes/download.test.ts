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
    getStream: mock(() => Promise.resolve(null)),
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
import { downloadRoutes } from '../../routes/download';

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

    it('should return 500 when signed URL generation fails', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ dl: 0, dlimit: 10 }));
        mockStorage.getSignedDownloadUrl.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(new Request('http://localhost/download/direct/abc123'));

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toContain('Failed to generate download URL');
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
});

describe('POST /download/complete/:id', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.incrementDownloadCount.mockReset();
        mockStorage.incrementDownloadCount.mockResolvedValue(1);
        mockStorage.del.mockReset();
        mockStorage.del.mockResolvedValue(undefined);
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
    });

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
    });

    it('should set auth field for valid owner', async () => {
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
});
