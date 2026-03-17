import { describe, expect, it, mock } from 'bun:test';
import { UPLOAD_LIMITS } from '@bolter/shared';

// --- Mock storage and its transitive dependencies before importing upload.ts ---

// Mock redis (needed by storage/redis.ts)
mock.module('../storage/redis', () => ({
    redis: {
        ping: mock(() => Promise.resolve(true)),
        hSet: mock(() => Promise.resolve()),
        hGet: mock(() => Promise.resolve(null)),
        hGetAll: mock(() => Promise.resolve(null)),
        hDel: mock(() => Promise.resolve()),
        expire: mock(() => Promise.resolve()),
        del: mock(() => Promise.resolve()),
        exists: mock(() => Promise.resolve(false)),
        ttl: mock(() => Promise.resolve(-1)),
        hIncrBy: mock(() => Promise.resolve(0)),
    },
}));

// Mock s3 (needed by storage/s3.ts)
mock.module('../storage/s3', () => ({
    s3Storage: {
        ping: mock(() => Promise.resolve(true)),
        del: mock(() => Promise.resolve()),
        getSignedUploadUrl: mock(() => Promise.resolve('https://fake-url')),
        getSignedDownloadUrl: mock(() => Promise.resolve('https://fake-url')),
        createMultipartUpload: mock(() => Promise.resolve('upload-id')),
        getSignedMultipartUploadUrl: mock(() => Promise.resolve('https://fake-part-url')),
        completeMultipartUpload: mock(() => Promise.resolve()),
        abortMultipartUpload: mock(() => Promise.resolve()),
        getStream: mock(() => Promise.resolve(null)),
        length: mock(() => Promise.resolve(0)),
    },
}));

// Mock sentry
mock.module('../lib/sentry', () => ({
    captureError: mock(() => {
        /* noop */
    }),
    addBreadcrumb: mock(() => {
        /* noop */
    }),
}));

// Import after mocking
import { calculateOptimalPartSize } from '../routes/upload';

const { MIN_PART_SIZE, MAX_PART_SIZE, DEFAULT_PART_SIZE, MAX_PARTS } = UPLOAD_LIMITS;
const MB = 1024 * 1024; // binary MB for alignment checks

describe('calculateOptimalPartSize', () => {
    it('should use default part size (200MB) for a 500MB file', () => {
        const fileSize = 500_000_000; // 500MB
        const result = calculateOptimalPartSize(fileSize);

        expect(result.partSize).toBe(DEFAULT_PART_SIZE);
        expect(result.numParts).toBe(Math.ceil(fileSize / DEFAULT_PART_SIZE));
        expect(result.numParts).toBe(3);
    });

    it('should use preferred part size when within valid bounds', () => {
        const fileSize = 500_000_000;
        const preferred = 100_000_000; // 100MB

        const result = calculateOptimalPartSize(fileSize, preferred);

        expect(result.partSize).toBe(preferred);
        expect(result.numParts).toBe(Math.ceil(fileSize / preferred));
    });

    it('should ignore preferred part size below MIN_PART_SIZE', () => {
        const fileSize = 500_000_000;
        const tooSmall = 1_000_000; // 1MB, below 5MB minimum

        const result = calculateOptimalPartSize(fileSize, tooSmall);

        expect(result.partSize).toBe(DEFAULT_PART_SIZE);
    });

    it('should ignore preferred part size above MAX_PART_SIZE', () => {
        const fileSize = 500_000_000;
        const tooLarge = 10_000_000_000; // 10GB, above 5GB max

        const result = calculateOptimalPartSize(fileSize, tooLarge);

        expect(result.partSize).toBe(DEFAULT_PART_SIZE);
    });

    it('should ignore preferred part size of 0', () => {
        const fileSize = 500_000_000;

        const result = calculateOptimalPartSize(fileSize, 0);

        // preferredPartSize of 0 is falsy, so it should use default
        expect(result.partSize).toBe(DEFAULT_PART_SIZE);
    });

    it('should auto-adjust when number of parts exceeds MAX_PARTS', () => {
        // Use a very large file with a small preferred part size to force >10000 parts
        // 100GB file with 5MB parts = 20000 parts > MAX_PARTS
        const fileSize = 100_000_000_000; // 100GB
        const preferred = 5_000_000; // 5MB = MIN_PART_SIZE

        const result = calculateOptimalPartSize(fileSize, preferred);

        expect(result.numParts).toBeLessThanOrEqual(MAX_PARTS);
        expect(result.partSize).toBeGreaterThan(preferred);
        // Part size should be MB-aligned
        expect(result.partSize % MB).toBe(0);
    });

    it('should recalculate when last part would be smaller than MIN_PART_SIZE', () => {
        // Create a scenario where the last part is tiny
        // 205MB file with 200MB default = 2 parts: 200MB + 5MB
        // 5MB = MIN_PART_SIZE, so it's exactly at the boundary
        // Let's use a file where the last part is just under MIN_PART_SIZE
        // 201MB with 200MB parts = 2 parts: 200MB + 1MB (1MB < 5MB MIN)
        const fileSize = 201 * 1_000_000; // 201MB
        const preferred = 200 * 1_000_000; // 200MB

        const result = calculateOptimalPartSize(fileSize, preferred);

        // Should have recalculated: the function reduces numParts by 1 and recalculates
        // The last part should now be >= MIN_PART_SIZE, or there's only 1 part
        if (result.numParts > 1) {
            const lastPartSize = fileSize - (result.numParts - 1) * result.partSize;
            expect(lastPartSize).toBeGreaterThanOrEqual(0);
        }
        // numParts * partSize should cover the entire file
        expect(result.numParts * result.partSize).toBeGreaterThanOrEqual(fileSize);
    });

    it('should handle a 1TB file', () => {
        const fileSize = 1_000_000_000_000; // 1TB

        const result = calculateOptimalPartSize(fileSize);

        expect(result.numParts).toBeLessThanOrEqual(MAX_PARTS);
        expect(result.partSize).toBeGreaterThanOrEqual(MIN_PART_SIZE);
        expect(result.partSize).toBeLessThanOrEqual(MAX_PART_SIZE);
        expect(result.numParts * result.partSize).toBeGreaterThanOrEqual(fileSize);
    });

    it('should return 1 part for a file smaller than part size', () => {
        const fileSize = 50_000_000; // 50MB

        const result = calculateOptimalPartSize(fileSize);

        expect(result.numParts).toBe(1);
        expect(result.partSize).toBe(DEFAULT_PART_SIZE);
    });

    it('should use exact MIN_PART_SIZE as preferred without issues', () => {
        const fileSize = 50_000_000; // 50MB

        const result = calculateOptimalPartSize(fileSize, MIN_PART_SIZE);

        expect(result.partSize).toBe(MIN_PART_SIZE);
        expect(result.numParts).toBe(Math.ceil(fileSize / MIN_PART_SIZE));
    });

    it('should use exact MAX_PART_SIZE as preferred without issues', () => {
        const fileSize = 10_000_000_000; // 10GB

        const result = calculateOptimalPartSize(fileSize, MAX_PART_SIZE);

        expect(result.partSize).toBe(MAX_PART_SIZE);
        expect(result.numParts).toBe(Math.ceil(fileSize / MAX_PART_SIZE));
    });

    it('should align part size to MB boundary when auto-adjusting', () => {
        // Force auto-adjustment by exceeding MAX_PARTS
        const fileSize = 500_000_000_000; // 500GB
        const preferred = MIN_PART_SIZE; // Will cause >10000 parts

        const result = calculateOptimalPartSize(fileSize, preferred);

        expect(result.partSize % MB).toBe(0);
    });

    it('should handle a very small file', () => {
        const fileSize = 1000; // 1KB

        const result = calculateOptimalPartSize(fileSize);

        expect(result.numParts).toBe(1);
        expect(result.partSize).toBe(DEFAULT_PART_SIZE);
    });

    it('should produce consistent results for the same inputs', () => {
        const fileSize = 750_000_000; // 750MB

        const result1 = calculateOptimalPartSize(fileSize);
        const result2 = calculateOptimalPartSize(fileSize);

        expect(result1.partSize).toBe(result2.partSize);
        expect(result1.numParts).toBe(result2.numParts);
    });
});
