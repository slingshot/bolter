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
    incrementDownloadCount: mock(() => Promise.resolve(0)),
    getTTL: mock(() => Promise.resolve(-1)),
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

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { Elysia } from 'elysia';
import { uploadRoutes } from '../../routes/upload';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
    return new Elysia().use(uploadRoutes);
}

function jsonPost(path: string, body: Record<string, unknown>) {
    return new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// Default metadata returned by getMetadata when a file "exists"
function makeMetadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
    return {
        id: 'abc123',
        prefix: '1',
        owner: 'owner-token',
        encrypted: false,
        dl: 0,
        dlimit: 10,
        fileSize: 50_000_000,
        metadata: undefined,
        auth: undefined,
        nonce: undefined,
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

describe('POST /upload/url', () => {
    beforeEach(() => {
        // Reset all mocks to their default implementations
        mockStorage.getSignedUploadUrl.mockReset();
        mockStorage.getSignedUploadUrl.mockResolvedValue(
            'https://s3.example.com/upload?signed=true',
        );
        mockStorage.createMultipartUpload.mockReset();
        mockStorage.createMultipartUpload.mockResolvedValue('test-upload-id');
        mockStorage.getSignedMultipartUploadUrl.mockReset();
        mockStorage.getSignedMultipartUploadUrl.mockResolvedValue(
            'https://s3.example.com/part?signed=true',
        );
        mockStorage.setField.mockReset();
        mockStorage.setField.mockResolvedValue(undefined);
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);
    });

    it('should return a single URL for a small file (50MB)', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000 }));

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.useSignedUrl).toBe(true);
        expect(body.multipart).toBe(false);
        expect(body.id).toBeDefined();
        expect(body.owner).toBeDefined();
        expect(body.url).toBe('https://s3.example.com/upload?signed=true');
        expect(body.completeUrl).toContain('/download/');
    });

    it('should return multipart=true with parts for a large file (500MB)', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.useSignedUrl).toBe(true);
        expect(body.multipart).toBe(true);
        expect(body.uploadId).toBe('test-upload-id');
        expect(body.parts).toBeDefined();
        expect(Array.isArray(body.parts)).toBe(true);
        expect(body.parts.length).toBeGreaterThan(0);
        expect(body.partSize).toBeDefined();

        // Each part should have the correct shape
        for (const part of body.parts) {
            expect(part.partNumber).toBeDefined();
            expect(part.url).toBe('https://s3.example.com/part?signed=true');
            expect(typeof part.minSize).toBe('number');
            expect(typeof part.maxSize).toBe('number');
        }
    });

    it('should return error for file size of 0', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 0 }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toBeDefined();
        expect(body.error).toContain('Invalid file size');
    });

    it('should return error for negative file size', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: -100 }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Invalid file size');
    });

    it('should return error for file exceeding MAX_FILE_SIZE', async () => {
        const app = createApp();
        // MAX_FILE_SIZE is 1TB = 1_000_000_000_000
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 2_000_000_000_000 }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('File size exceeds maximum');
    });

    it('should return useSignedUrl=false when pre-signed URL test fails', async () => {
        mockStorage.getSignedUploadUrl.mockResolvedValueOnce(null);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000 }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.useSignedUrl).toBe(false);
    });

    it('should store encrypted=true when encrypted flag is passed', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000, encrypted: true }));

        // Check that setField was called with 'encrypted' = 'true'
        const encryptedCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'encrypted' && call[2] === 'true',
        );
        expect(encryptedCalls.length).toBeGreaterThan(0);
    });

    it('should store encrypted=false when encrypted flag is not passed', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000 }));

        const encryptedCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'encrypted' && call[2] === 'false',
        );
        expect(encryptedCalls.length).toBeGreaterThan(0);
    });

    it('should cap timeLimit at maxExpireSeconds', async () => {
        const app = createApp();
        // Send an absurdly large timeLimit (greater than 6 months)
        const hugeTimeLimit = 86400 * 365; // 1 year
        await app.handle(
            jsonPost('/upload/url', { fileSize: 50_000_000, timeLimit: hugeTimeLimit }),
        );

        // The expire call should use maxExpireSeconds (86400*180) as the cap
        const maxExpireSeconds = 86400 * 180;
        const expireCalls = mockRedis.expire.mock.calls;
        expect(expireCalls.length).toBeGreaterThan(0);
        // The second argument to expire should be <= maxExpireSeconds
        const usedExpire = expireCalls[0][1] as number;
        expect(usedExpire).toBeLessThanOrEqual(maxExpireSeconds);
    });

    it('should pass preferredPartSize to calculateOptimalPartSize for multipart uploads', async () => {
        const app = createApp();
        const preferredPartSize = 100_000_000; // 100MB
        const res = await app.handle(
            jsonPost('/upload/url', { fileSize: 500_000_000, preferredPartSize }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.multipart).toBe(true);
        // With a preferred part size of 100MB and 500MB file, we should get 5 parts
        expect(body.partSize).toBe(preferredPartSize);
        expect(body.parts.length).toBe(5);
    });

    it('should return useSignedUrl=false when multipart upload creation fails', async () => {
        mockStorage.createMultipartUpload.mockResolvedValueOnce(null);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));

        expect(res.status).toBe(200);
        const body = await res.json();
        // The first getSignedUploadUrl call is the pre-signed URL test, which succeeds.
        // Then createMultipartUpload fails, so it returns useSignedUrl: false.
        expect(body.useSignedUrl).toBe(false);
    });
});

describe('POST /upload/complete', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.setField.mockReset();
        mockStorage.setField.mockResolvedValue(undefined);
        mockStorage.completeMultipartUpload.mockReset();
        mockStorage.completeMultipartUpload.mockResolvedValue(undefined);
        mockRedis.hDel.mockReset();
        mockRedis.hDel.mockResolvedValue(undefined);
    });

    it('should complete a single (non-multipart) upload and return success', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, multipart: false }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/complete', {
                id: 'abc123',
                metadata: btoa(JSON.stringify({ files: [{ name: 'test.txt' }] })),
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.id).toBe('abc123');
        expect(body.url).toContain('/download/abc123');

        // Should NOT have called completeMultipartUpload
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(0);

        // Should have stored auth as 'unencrypted'
        const authCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'auth' && call[2] === 'unencrypted',
        );
        expect(authCalls.length).toBe(1);
    });

    it('should complete a multipart upload with sorted parts', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 3,
            }),
        );

        const parts = [
            { PartNumber: 3, ETag: '"etag3"' },
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // completeMultipartUpload should have been called with sorted parts
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(1);
        const calledParts = mockStorage.completeMultipartUpload.mock.calls[0][2];
        expect(calledParts[0].PartNumber).toBe(1);
        expect(calledParts[1].PartNumber).toBe(2);
        expect(calledParts[2].PartNumber).toBe(3);

        // Should have cleaned up multipart metadata
        expect(mockRedis.hDel.mock.calls.length).toBe(1);
    });

    it('should return error for encrypted file without authKey', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: true }));

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Missing or invalid auth key');
    });

    it('should store auth and nonce for encrypted file with authKey', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: true }));

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/complete', {
                id: 'abc123',
                authKey: 'dGVzdC1hdXRoLWtleQ==',
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // Should have stored auth key
        const authCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'auth' && call[2] === 'dGVzdC1hdXRoLWtleQ==',
        );
        expect(authCalls.length).toBe(1);

        // Should have stored a nonce
        const nonceCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'nonce',
        );
        expect(nonceCalls.length).toBe(1);
        // The nonce should be a non-empty base64 string
        expect((nonceCalls[0] as unknown[])[2]).toBeTruthy();
    });

    it('should store auth as "unencrypted" for unencrypted file', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));

        const app = createApp();
        await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        const authCalls = mockStorage.setField.mock.calls.filter(
            (call: unknown[]) => call[1] === 'auth' && call[2] === 'unencrypted',
        );
        expect(authCalls.length).toBe(1);
    });

    it('should return error when file ID is missing', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: '' }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Missing file ID');
    });

    it('should return error when file not found', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'nonexistent' }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });

    it('should return error when too many parts are sent', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
            { PartNumber: 3, ETag: '"etag3"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Too many parts');
    });

    it('should return 404 message for NoSuchUpload error', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );
        const err = new Error('NoSuchUpload') as Error & { code?: string };
        err.code = 'NoSuchUpload';
        mockStorage.completeMultipartUpload.mockRejectedValue(err);

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Upload not found or expired');
        expect(body.status).toBe(404);
    });

    it('should return 400 message for InvalidPart error', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );
        const err = new Error('InvalidPart') as Error & { code?: string };
        err.code = 'InvalidPart';
        mockStorage.completeMultipartUpload.mockRejectedValue(err);

        const parts = [
            { PartNumber: 1, ETag: '"bad-etag"' },
            { PartNumber: 2, ETag: '"bad-etag"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Invalid upload parts');
        expect(body.status).toBe(400);
    });

    it('should return 400 message for EntityTooSmall error', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );
        const err = new Error('EntityTooSmall') as Error & { code?: string };
        err.code = 'EntityTooSmall';
        mockStorage.completeMultipartUpload.mockRejectedValue(err);

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Upload parts too small');
        expect(body.status).toBe(400);
    });
});

describe('POST /upload/abort/:id', () => {
    beforeEach(() => {
        mockStorage.abortMultipartUpload.mockReset();
        mockStorage.abortMultipartUpload.mockResolvedValue(undefined);
        mockRedis.del.mockReset();
        mockRedis.del.mockResolvedValue(undefined);
    });

    it('should abort upload and clean up redis', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/abort/abc123', { uploadId: 'mp-upload-id' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(1);
        expect(mockStorage.abortMultipartUpload.mock.calls[0][0]).toBe('abc123');
        expect(mockStorage.abortMultipartUpload.mock.calls[0][1]).toBe('mp-upload-id');

        expect(mockRedis.del.mock.calls.length).toBe(1);
        expect(mockRedis.del.mock.calls[0][0]).toBe('abc123');
    });

    it('should return error when abort fails', async () => {
        mockStorage.abortMultipartUpload.mockRejectedValue(new Error('S3 error'));

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/abort/abc123', { uploadId: 'mp-upload-id' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Failed to abort upload');
    });
});

describe('POST /upload/multipart/:id/resume', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.getSignedMultipartUploadUrl.mockReset();
        mockStorage.getSignedMultipartUploadUrl.mockResolvedValue(
            'https://s3.example.com/part?signed=true',
        );
    });

    it('should generate URLs for remaining parts (filter completed)', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 5,
                partSize: 200_000_000,
            }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/multipart/abc123/resume', {
                uploadId: 'mp-upload-id',
                completedPartNumbers: [1, 3],
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();

        // Should return URLs for parts 2, 4, 5 (not 1 and 3)
        expect(body.parts.length).toBe(3);
        const partNumbers = body.parts.map((p: { partNumber: number }) => p.partNumber);
        expect(partNumbers).toContain(2);
        expect(partNumbers).toContain(4);
        expect(partNumbers).toContain(5);
        expect(partNumbers).not.toContain(1);
        expect(partNumbers).not.toContain(3);

        expect(body.partSize).toBe(200_000_000);
        expect(body.numParts).toBe(5);
    });

    it('should return 404 when file not found', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/multipart/nonexistent/resume', {
                uploadId: 'mp-upload-id',
                completedPartNumbers: [],
            }),
        );

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('Upload not found');
    });

    it('should return 400 when upload ID mismatches', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'real-upload-id',
                numParts: 5,
            }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/multipart/abc123/resume', {
                uploadId: 'wrong-upload-id',
                completedPartNumbers: [],
            }),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Upload ID mismatch');
    });

    it('should return empty parts array when all parts are completed', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 3,
                partSize: 200_000_000,
            }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/multipart/abc123/resume', {
                uploadId: 'mp-upload-id',
                completedPartNumbers: [1, 2, 3],
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.parts.length).toBe(0);
    });
});

describe('POST /upload/speedtest', () => {
    beforeEach(() => {
        mockStorage.createMultipartUpload.mockReset();
        mockStorage.createMultipartUpload.mockResolvedValue('test-upload-id');
        mockStorage.getSignedMultipartUploadUrl.mockReset();
        mockStorage.getSignedMultipartUploadUrl.mockResolvedValue(
            'https://s3.example.com/part?signed=true',
        );
    });

    it('should return testId, uploadId, and 5 parts', async () => {
        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/upload/speedtest', { method: 'POST' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.testId).toBeDefined();
        expect(body.testId).toContain('__speedtest__');
        expect(body.uploadId).toBe('test-upload-id');
        expect(body.parts).toBeDefined();
        expect(body.parts.length).toBe(5);

        for (const part of body.parts) {
            expect(part.partNumber).toBeDefined();
            expect(part.url).toBe('https://s3.example.com/part?signed=true');
        }

        // Part numbers should be 1-5
        const partNumbers = body.parts.map((p: { partNumber: number }) => p.partNumber);
        expect(partNumbers).toEqual([1, 2, 3, 4, 5]);
    });

    it('should return error when multipart creation fails', async () => {
        mockStorage.createMultipartUpload.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/upload/speedtest', { method: 'POST' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.error).toContain('Failed to create speed test upload');
    });
});

describe('POST /upload/speedtest/cleanup', () => {
    beforeEach(() => {
        mockStorage.abortMultipartUpload.mockReset();
        mockStorage.abortMultipartUpload.mockResolvedValue(undefined);
    });

    it('should call abortMultipartUpload to clean up', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/speedtest/cleanup', {
                testId: '__speedtest__abc123',
                uploadId: 'test-upload-id',
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);

        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(1);
        expect(mockStorage.abortMultipartUpload.mock.calls[0][0]).toBe('__speedtest__abc123');
        expect(mockStorage.abortMultipartUpload.mock.calls[0][1]).toBe('test-upload-id');
    });

    it('should return ok even if abort fails', async () => {
        mockStorage.abortMultipartUpload.mockRejectedValue(new Error('S3 error'));

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/speedtest/cleanup', {
                testId: '__speedtest__abc123',
                uploadId: 'test-upload-id',
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
    });

    it('should handle missing uploadId gracefully', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/speedtest/cleanup', {
                testId: '__speedtest__abc123',
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);

        // abortMultipartUpload should NOT be called when uploadId is falsy
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(0);
    });
});
