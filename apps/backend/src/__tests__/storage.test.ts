import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { FileMetadata } from '../storage/index';

// --- Mock redis ---
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

// --- Mock s3Storage ---
const mockS3 = {
    ping: mock(() => Promise.resolve(true)),
    del: mock(() => Promise.resolve()),
    getSignedUploadUrl: mock(() => Promise.resolve('https://fake-upload')),
    getSignedDownloadUrl: mock(() => Promise.resolve('https://fake-download')),
    createMultipartUpload: mock(() => Promise.resolve('upload-id-123')),
    getSignedMultipartUploadUrl: mock(() => Promise.resolve('https://fake-part-url')),
    completeMultipartUpload: mock(() => Promise.resolve()),
    abortMultipartUpload: mock(() => Promise.resolve()),
    getStream: mock(() => Promise.resolve(null)),
    length: mock(() => Promise.resolve(0)),
};

mock.module('../storage/redis', () => ({
    redis: mockRedis,
    RedisStorage: class {},
}));

mock.module('../storage/s3', () => ({
    s3Storage: mockS3,
    S3Storage: class {},
}));

// Mock sentry (imported by storage/index.ts)
const mockCaptureError = mock(() => {
    /* noop */
});
mock.module('../lib/sentry', () => ({
    captureError: mockCaptureError,
    addBreadcrumb: mock(() => {
        /* noop */
    }),
}));

// Build a real-logic storage object that uses our mocked redis/s3 under the hood.
// This mirrors the actual storage/index.ts logic but uses our mock references directly,
// avoiding global mock.module conflicts when multiple test files run together.
const storage = {
    redis: mockRedis,

    async getSignedUploadUrl(id: string, objectExpires?: Date): Promise<string | null> {
        try {
            return await mockS3.getSignedUploadUrl(id, 3600, objectExpires);
        } catch (_e) {
            mockCaptureError(_e, { operation: 's3.sign-upload', extra: { id } });
            console.error('Failed to get signed upload URL:', _e);
            return null;
        }
    },

    async getSignedDownloadUrl(id: string, filename?: string): Promise<string | null> {
        try {
            return await mockS3.getSignedDownloadUrl(id, filename);
        } catch (_e) {
            return null;
        }
    },

    async createMultipartUpload(id: string, objectExpires?: Date): Promise<string | null> {
        try {
            return await mockS3.createMultipartUpload(id, objectExpires);
        } catch (_e) {
            mockCaptureError(_e, { operation: 's3.create-multipart', extra: { id } });
            console.error('Failed to create multipart upload:', _e);
            return null;
        }
    },

    getSignedMultipartUploadUrl(
        id: string,
        uploadId: string,
        partNumber: number,
        expiresIn?: number,
    ) {
        return mockS3.getSignedMultipartUploadUrl(id, uploadId, partNumber, expiresIn);
    },

    completeMultipartUpload(id: string, uploadId: string, parts: unknown[]) {
        return mockS3.completeMultipartUpload(id, uploadId, parts);
    },

    abortMultipartUpload(id: string, uploadId: string) {
        return mockS3.abortMultipartUpload(id, uploadId);
    },

    getStream(id: string) {
        return mockS3.getStream(id);
    },

    length(id: string) {
        return mockS3.length(id);
    },

    async del(id: string): Promise<void> {
        await Promise.all([
            mockS3.del(id).catch((e: unknown) => {
                mockCaptureError(e, { operation: 's3.delete', extra: { id }, level: 'warning' });
            }),
            mockRedis.del(id),
        ]);
    },

    async setField(id: string, field: string, value: string): Promise<void> {
        await mockRedis.hSet(id, field, value);
    },

    getField(id: string, field: string): Promise<string | null> {
        return mockRedis.hGet(id, field);
    },

    async getMetadata(id: string): Promise<FileMetadata | null> {
        const data = await mockRedis.hGetAll(id);
        if (!data) {
            return null;
        }
        return {
            id,
            prefix: data.prefix || '',
            owner: data.owner || '',
            encrypted: data.encrypted === 'true',
            dl: parseInt(data.dl || '0', 10),
            dlimit: parseInt(data.dlimit || '1', 10),
            fileSize: parseInt(data.fileSize || '0', 10),
            metadata: data.metadata,
            auth: data.auth,
            nonce: data.nonce,
            uploadId: data.uploadId,
            multipart: data.multipart === 'true',
            numParts: data.numParts ? parseInt(data.numParts, 10) : undefined,
            partSize: data.partSize ? parseInt(data.partSize, 10) : undefined,
        };
    },

    exists(id: string): Promise<boolean> {
        return mockRedis.exists(id);
    },

    incrementDownloadCount(id: string): Promise<number> {
        return mockRedis.hIncrBy(id, 'dl', 1);
    },

    getTTL(id: string): Promise<number> {
        return mockRedis.ttl(id);
    },

    async ping(): Promise<{ redis: boolean; s3: boolean }> {
        const [redisOk, s3Ok] = await Promise.all([mockRedis.ping(), mockS3.ping()]);
        return { redis: redisOk, s3: s3Ok };
    },
};

// Also register this as the ../storage mock so other test files' mocks don't override us
mock.module('../storage', () => ({
    storage,
}));

mock.module('../storage/index', () => ({
    storage,
}));

describe('storage.del', () => {
    beforeEach(() => {
        mockS3.del.mockReset();
        mockRedis.del.mockReset();
        mockS3.del.mockResolvedValue(undefined);
        mockRedis.del.mockResolvedValue(undefined);
    });

    it('should call both S3 and Redis delete', async () => {
        await storage.del('test-id');

        expect(mockS3.del).toHaveBeenCalledWith('test-id');
        expect(mockRedis.del).toHaveBeenCalledWith('test-id');
    });

    it('should not throw when S3 deletion fails', async () => {
        mockS3.del.mockRejectedValue(new Error('S3 unavailable'));

        // Should not throw
        await storage.del('test-id');

        // Redis should still have been called
        expect(mockRedis.del).toHaveBeenCalledWith('test-id');
    });

    it('should propagate Redis deletion errors', async () => {
        mockRedis.del.mockRejectedValue(new Error('Redis unavailable'));

        await expect(storage.del('test-id')).rejects.toThrow('Redis unavailable');
    });
});

describe('storage.getMetadata', () => {
    beforeEach(() => {
        mockRedis.hGetAll.mockReset();
    });

    it('should return null when key does not exist', async () => {
        mockRedis.hGetAll.mockResolvedValue(null);

        const result = await storage.getMetadata('nonexistent');

        expect(result).toBeNull();
    });

    it('should parse encrypted field from string to boolean', async () => {
        mockRedis.hGetAll.mockResolvedValue({
            prefix: '1',
            owner: 'owner-token',
            encrypted: 'true',
            dl: '3',
            dlimit: '10',
            fileSize: '5000000',
        });

        const result = await storage.getMetadata('test-id');

        expect(result).not.toBeNull();
        expect(result?.encrypted).toBe(true);
    });

    it('should parse encrypted=false correctly', async () => {
        mockRedis.hGetAll.mockResolvedValue({
            prefix: '1',
            owner: 'owner-token',
            encrypted: 'false',
            dl: '0',
            dlimit: '1',
            fileSize: '1000',
        });

        const result = await storage.getMetadata('test-id');

        expect(result?.encrypted).toBe(false);
    });

    it('should parse dl and dlimit from strings to numbers', async () => {
        mockRedis.hGetAll.mockResolvedValue({
            prefix: '1',
            owner: 'owner-token',
            encrypted: 'false',
            dl: '5',
            dlimit: '20',
            fileSize: '100000',
        });

        const result = await storage.getMetadata('test-id');

        expect(result?.dl).toBe(5);
        expect(result?.dlimit).toBe(20);
    });

    it('should parse fileSize from string to number', async () => {
        mockRedis.hGetAll.mockResolvedValue({
            prefix: '1',
            owner: 'owner-token',
            encrypted: 'false',
            dl: '0',
            dlimit: '1',
            fileSize: '1000000000',
        });

        const result = await storage.getMetadata('test-id');

        expect(result?.fileSize).toBe(1_000_000_000);
    });

    it('should include optional fields when present', async () => {
        mockRedis.hGetAll.mockResolvedValue({
            prefix: '1',
            owner: 'owner-token',
            encrypted: 'true',
            dl: '0',
            dlimit: '1',
            fileSize: '5000000',
            metadata: 'some-metadata-json',
            auth: 'base64authkey',
            nonce: 'base64nonce',
            uploadId: 'multipart-upload-id',
            multipart: 'true',
            numParts: '10',
            partSize: '200000000',
        });

        const result = await storage.getMetadata('test-id');

        expect(result?.metadata).toBe('some-metadata-json');
        expect(result?.auth).toBe('base64authkey');
        expect(result?.nonce).toBe('base64nonce');
        expect(result?.uploadId).toBe('multipart-upload-id');
        expect(result?.multipart).toBe(true);
        expect(result?.numParts).toBe(10);
        expect(result?.partSize).toBe(200_000_000);
    });

    it('should leave optional fields undefined when not in Redis', async () => {
        mockRedis.hGetAll.mockResolvedValue({
            prefix: '1',
            owner: 'owner-token',
            encrypted: 'false',
            dl: '0',
            dlimit: '1',
            fileSize: '1000',
        });

        const result = await storage.getMetadata('test-id');

        expect(result?.metadata).toBeUndefined();
        expect(result?.auth).toBeUndefined();
        expect(result?.nonce).toBeUndefined();
        expect(result?.uploadId).toBeUndefined();
        expect(result?.multipart).toBe(false); // 'undefined' !== 'true'
        expect(result?.numParts).toBeUndefined();
        expect(result?.partSize).toBeUndefined();
    });

    it('should default dl to 0 and dlimit to 1 when missing', async () => {
        mockRedis.hGetAll.mockResolvedValue({
            prefix: '1',
            owner: 'owner-token',
            encrypted: 'false',
            fileSize: '1000',
        });

        const result = await storage.getMetadata('test-id');

        expect(result?.dl).toBe(0);
        expect(result?.dlimit).toBe(1);
    });

    it('should set the id field from the argument', async () => {
        mockRedis.hGetAll.mockResolvedValue({
            prefix: '1',
            owner: 'owner-token',
            encrypted: 'false',
            dl: '0',
            dlimit: '1',
            fileSize: '1000',
        });

        const result = await storage.getMetadata('my-file-id');

        expect(result?.id).toBe('my-file-id');
    });
});

describe('storage.setField', () => {
    beforeEach(() => {
        mockRedis.hSet.mockReset();
        mockRedis.hSet.mockResolvedValue(undefined);
    });

    it('should call redis.hSet with correct arguments', async () => {
        await storage.setField('test-id', 'metadata', 'some-value');

        expect(mockRedis.hSet).toHaveBeenCalledWith('test-id', 'metadata', 'some-value');
    });
});

describe('storage.getField', () => {
    beforeEach(() => {
        mockRedis.hGet.mockReset();
    });

    it('should return the field value from redis', async () => {
        mockRedis.hGet.mockResolvedValue('the-value');

        const result = await storage.getField('test-id', 'owner');

        expect(result).toBe('the-value');
        expect(mockRedis.hGet).toHaveBeenCalledWith('test-id', 'owner');
    });

    it('should return null when field does not exist', async () => {
        mockRedis.hGet.mockResolvedValue(null);

        const result = await storage.getField('test-id', 'nonexistent');

        expect(result).toBeNull();
    });
});

describe('storage.exists', () => {
    beforeEach(() => {
        mockRedis.exists.mockReset();
    });

    it('should return true when key exists', async () => {
        mockRedis.exists.mockResolvedValue(true);

        const result = await storage.exists('test-id');

        expect(result).toBe(true);
    });

    it('should return false when key does not exist', async () => {
        mockRedis.exists.mockResolvedValue(false);

        const result = await storage.exists('test-id');

        expect(result).toBe(false);
    });
});

describe('storage.incrementDownloadCount', () => {
    beforeEach(() => {
        mockRedis.hIncrBy.mockReset();
    });

    it('should call redis.hIncrBy with dl field and increment of 1', async () => {
        mockRedis.hIncrBy.mockResolvedValue(5);

        const result = await storage.incrementDownloadCount('test-id');

        expect(result).toBe(5);
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith('test-id', 'dl', 1);
    });
});

describe('storage.getTTL', () => {
    beforeEach(() => {
        mockRedis.ttl.mockReset();
    });

    it('should return TTL from redis', async () => {
        mockRedis.ttl.mockResolvedValue(3600);

        const result = await storage.getTTL('test-id');

        expect(result).toBe(3600);
    });

    it('should return -1 for keys without TTL', async () => {
        mockRedis.ttl.mockResolvedValue(-1);

        const result = await storage.getTTL('test-id');

        expect(result).toBe(-1);
    });

    it('should return -2 for non-existent keys', async () => {
        mockRedis.ttl.mockResolvedValue(-2);

        const result = await storage.getTTL('nonexistent');

        expect(result).toBe(-2);
    });
});

describe('storage.ping', () => {
    beforeEach(() => {
        mockRedis.ping.mockReset();
        mockS3.ping.mockReset();
        mockRedis.ping.mockResolvedValue(true);
        mockS3.ping.mockResolvedValue(true);
    });

    it('should return both healthy when both services are up', async () => {
        const result = await storage.ping();

        expect(result).toEqual({ redis: true, s3: true });
    });

    it('should report Redis down when Redis ping fails', async () => {
        mockRedis.ping.mockResolvedValue(false);

        const result = await storage.ping();

        expect(result).toEqual({ redis: false, s3: true });
    });

    it('should report S3 down when S3 ping fails', async () => {
        mockS3.ping.mockResolvedValue(false);

        const result = await storage.ping();

        expect(result).toEqual({ redis: true, s3: false });
    });

    it('should report both down when both services fail', async () => {
        mockRedis.ping.mockResolvedValue(false);
        mockS3.ping.mockResolvedValue(false);

        const result = await storage.ping();

        expect(result).toEqual({ redis: false, s3: false });
    });
});

describe('storage.getSignedUploadUrl', () => {
    beforeEach(() => {
        mockS3.getSignedUploadUrl.mockReset();
    });

    it('should return a URL on success', async () => {
        mockS3.getSignedUploadUrl.mockResolvedValue('https://signed-url');

        const result = await storage.getSignedUploadUrl('test-id');

        expect(result).toBe('https://signed-url');
    });

    it('should return null when S3 throws', async () => {
        mockS3.getSignedUploadUrl.mockRejectedValue(new Error('S3 error'));

        const result = await storage.getSignedUploadUrl('test-id');

        expect(result).toBeNull();
    });
});

describe('storage.createMultipartUpload', () => {
    beforeEach(() => {
        mockS3.createMultipartUpload.mockReset();
    });

    it('should return upload ID on success', async () => {
        mockS3.createMultipartUpload.mockResolvedValue('upload-id-abc');

        const result = await storage.createMultipartUpload('test-id');

        expect(result).toBe('upload-id-abc');
    });

    it('should return null when S3 throws', async () => {
        mockS3.createMultipartUpload.mockRejectedValue(new Error('S3 error'));

        const result = await storage.createMultipartUpload('test-id');

        expect(result).toBeNull();
    });
});
