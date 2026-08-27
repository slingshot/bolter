import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
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
import { DOWNLOAD_LIMITS, PART_SIZING, TIME_LIMITS } from '@bolter/shared';
import {
    calculateOptimalPartSize,
    clampDownloadLimit,
    clampExpireSeconds,
    uploadTokenEnforced,
    verifyUploadToken,
} from '../routes/upload';

const { MIN_PART_SIZE, MAX_PART_SIZE, MAX_PARTS } = UPLOAD_LIMITS;
const MB = 1024 * 1024; // binary MB for alignment checks

describe('calculateOptimalPartSize', () => {
    // Verified curve. Part size is derived from file size alone: R2 requires
    // uniform non-trailing parts, so it is decided once at allocation and can
    // never adapt mid-upload. 10GB and 50GB are load-bearing rows — they are
    // where the trailing-part correction fires and 64 MiB becomes 65 MiB.
    it.each([
        ['100 MB', 100_000_000, 64 * MB, 2],
        ['500 MB', 500_000_000, 64 * MB, 8],
        ['1 GB', 1_000_000_000, 64 * MB, 15],
        ['5 GB', 5_000_000_000, 64 * MB, 75],
        ['10 GB', 10_000_000_000, 65 * MB, 147],
        ['50 GB', 50_000_000_000, 65 * MB, 734],
        ['100 GB', 100_000_000_000, 96 * MB, 994],
        ['500 GB', 500_000_000_000, 128 * MB, 3726],
        ['1 TB', 1_000_000_000_000, 128 * MB, 7451],
    ])('should size %s as %d-byte parts', (_label, fileSize, expectedPartSize, expectedParts) => {
        const result = calculateOptimalPartSize(fileSize);
        expect(result.partSize).toBe(expectedPartSize);
        expect(result.numParts).toBe(expectedParts);
    });

    it('should clamp small multipart uploads up to the floor', () => {
        // Just over MULTIPART_THRESHOLD: size/1000 is far below the floor.
        const result = calculateOptimalPartSize(UPLOAD_LIMITS.MULTIPART_THRESHOLD + 1);
        expect(result.partSize).toBe(PART_SIZING.FLOOR);
    });

    it('should clamp very large uploads down to the ceiling', () => {
        // 1TB/1000 is 1GB — the ceiling is what keeps parts sane.
        const result = calculateOptimalPartSize(1_000_000_000_000);
        expect(result.partSize).toBe(PART_SIZING.CEILING);
    });

    it('should take no client input', () => {
        // One argument only: the sizing decision lives in exactly one place.
        expect(calculateOptimalPartSize.length).toBe(1);
    });

    it('should produce consistent results for the same input', () => {
        const a = calculateOptimalPartSize(750_000_000);
        const b = calculateOptimalPartSize(750_000_000);
        expect(a).toEqual(b);
    });

    it('should return a single part below the floor', () => {
        const result = calculateOptimalPartSize(50_000_000);
        expect(result.numParts).toBe(1);
        expect(result.partSize).toBe(PART_SIZING.FLOOR);
    });
});

// The invariant that actually matters: no allocation may produce a
// non-trailing part below MIN_PART_SIZE, on any input. Sampled sizes miss it —
// this sweep is what found the single-pass bug.
describe('calculateOptimalPartSize invariants (sweep)', () => {
    const MULTIPART_THRESHOLD = UPLOAD_LIMITS.MULTIPART_THRESHOLD;
    const MAX_FILE_SIZE = UPLOAD_LIMITS.MAX_FILE_SIZE;

    function assertLegal(fileSize: number) {
        const { partSize, numParts } = calculateOptimalPartSize(fileSize);
        const trailing = numParts > 1 ? fileSize - (numParts - 1) * partSize : fileSize;

        // Messages carry fileSize so a sweep failure is reproducible from the output.
        expect(numParts, `numParts for ${fileSize}`).toBeLessThanOrEqual(MAX_PARTS);
        expect(numParts, `numParts for ${fileSize}`).toBeGreaterThanOrEqual(1);
        expect(partSize, `partSize for ${fileSize}`).toBeLessThanOrEqual(MAX_PART_SIZE);
        // Every path that sets partSize runs it through ceilToMiB, so alignment
        // is unconditional. Asserting it here catches a future path that forgets.
        expect(partSize % MB, `MiB alignment for ${fileSize}`).toBe(0);
        expect(numParts * partSize, `coverage for ${fileSize}`).toBeGreaterThanOrEqual(fileSize);
        if (numParts > 1) {
            expect(trailing, `trailing part for ${fileSize}`).toBeGreaterThanOrEqual(MIN_PART_SIZE);
        }
    }

    // 1 MiB granularity across the WHOLE range, not 1 GB above 2 GB. Coarse
    // sampling is why three wrong numbers reached the spec: every-1GB misses
    // the 4-and-5-pass convergence cases entirely (it tops out at 2) and never
    // sees the 130 MiB ceiling overshoot. ~953k inputs, a couple of seconds.
    it('should hold at 1 MiB granularity across the entire legal range', () => {
        const MiB = 1024 * 1024;
        for (let size = MULTIPART_THRESHOLD + 1; size <= MAX_FILE_SIZE; size += MiB) {
            assertLegal(size);
        }
    });

    it('should hold at boundary values', () => {
        for (const size of [
            MULTIPART_THRESHOLD + 1,
            MAX_FILE_SIZE,
            MAX_FILE_SIZE - 1,
            115_000_000_000, // failed under the single-pass adjustment
            779_000_000_000, // failed under the single-pass adjustment
            529_000_001, // fails TODAY on the 25MB tier (4.49 MiB trailing)
            616_000_000_000, // fails TODAY on the 50MB tier (3.4 MiB trailing)
            4_567_982_337, // worst observed convergence: 5 correction passes
        ]) {
            assertLegal(size);
        }
    });
});

// ---------------------------------------------------------------------------
// #5 — dlimit must be a positive integer clamped to config.maxDownloads
// ---------------------------------------------------------------------------

describe('clampDownloadLimit', () => {
    const MAX = DOWNLOAD_LIMITS.MAX_DOWNLOADS;
    const DEFAULT = DOWNLOAD_LIMITS.DEFAULT_DOWNLOADS;

    it('should fall back to the configured default when omitted', () => {
        expect(clampDownloadLimit(undefined)).toBe(DEFAULT);
    });

    it('should pass an in-range value through unchanged', () => {
        expect(clampDownloadLimit(20)).toBe(20);
    });

    it('should clamp an absurd limit down to the maximum', () => {
        // Unclamped, dl >= dlimit is unreachable: unlimited downloads
        expect(clampDownloadLimit(1_000_000_000)).toBe(MAX);
    });

    it('should raise a non-positive limit to 1 instead of bricking the file', () => {
        // A negative dlimit survived `||` and made dl >= dlimit true immediately
        expect(clampDownloadLimit(-1)).toBe(1);
        // 0 is finite, so it is a *requested* value clamped up to the floor —
        // not an omission falling back to the default. Asserting DEFAULT here
        // passed only while DEFAULT happened to be 1.
        expect(clampDownloadLimit(0)).toBe(1);
    });

    it('should truncate fractions so the stored value round-trips through parseInt', () => {
        expect(clampDownloadLimit(3.9)).toBe(3);
    });

    it('should never return a value that stringifies in exponential notation', () => {
        expect(clampDownloadLimit(1e21).toString()).not.toContain('e');
    });

    it('should fall back on non-finite input rather than storing NaN/Infinity', () => {
        expect(clampDownloadLimit(Number.NaN)).toBe(DEFAULT);
        expect(clampDownloadLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT);
    });
});

// ---------------------------------------------------------------------------
// #7 — timeLimit must never reach EXPIRE as a non-positive value
// ---------------------------------------------------------------------------

describe('clampExpireSeconds', () => {
    const MAX = TIME_LIMITS.MAX_EXPIRE_SECONDS;
    const DEFAULT = TIME_LIMITS.DEFAULT_EXPIRE_SECONDS;

    it('should fall back to the configured default when omitted', () => {
        expect(clampExpireSeconds(undefined)).toBe(DEFAULT);
    });

    it('should cap at the configured maximum', () => {
        expect(clampExpireSeconds(86400 * 365)).toBe(MAX);
    });

    it('should never return a non-positive TTL', () => {
        // EXPIRE(key, -1) DELETES the key; later HSETs then resurrect it
        // TTL-less, ownerless and providerId-less
        for (const bad of [-1, 0, -86400, Number.NaN, Number.NEGATIVE_INFINITY]) {
            expect(clampExpireSeconds(bad)).toBeGreaterThan(0);
        }
    });

    it('should truncate a fractional TTL', () => {
        expect(clampExpireSeconds(3600.7)).toBe(3600);
    });
});

// ---------------------------------------------------------------------------
// #52 — upload-owner token comparison
// ---------------------------------------------------------------------------

describe('verifyUploadToken', () => {
    const token = 'f'.repeat(32);
    const hash = createHash('sha256').update(token).digest('hex');

    it('should accept the matching token', () => {
        expect(verifyUploadToken(token, hash)).toBe(true);
    });

    it('should reject a different token', () => {
        expect(verifyUploadToken('e'.repeat(32), hash)).toBe(false);
    });

    it('should reject a missing or non-string token', () => {
        expect(verifyUploadToken(undefined, hash)).toBe(false);
        expect(verifyUploadToken('', hash)).toBe(false);
        expect(verifyUploadToken(123, hash)).toBe(false);
    });

    it('should reject rather than throw on a malformed stored hash', () => {
        expect(verifyUploadToken(token, 'not-a-hash')).toBe(false);
        expect(verifyUploadToken(token, '')).toBe(false);
    });
});

describe('uploadTokenEnforced', () => {
    const previous = process.env.UPLOAD_TOKEN_ENFORCED;

    afterEach(() => {
        if (previous === undefined) {
            delete process.env.UPLOAD_TOKEN_ENFORCED;
        } else {
            process.env.UPLOAD_TOKEN_ENFORCED = previous;
        }
    });

    it('should default to off so the shipped client keeps aborting and resuming', () => {
        delete process.env.UPLOAD_TOKEN_ENFORCED;
        expect(uploadTokenEnforced()).toBe(false);
    });

    it('should only enforce on an exact "true"', () => {
        for (const value of ['false', '1', 'yes', 'TRUE', '']) {
            process.env.UPLOAD_TOKEN_ENFORCED = value;
            expect(uploadTokenEnforced()).toBe(false);
        }
        process.env.UPLOAD_TOKEN_ENFORCED = 'true';
        expect(uploadTokenEnforced()).toBe(true);
    });

    it('should be read per call so the flag can be flipped at runtime', () => {
        process.env.UPLOAD_TOKEN_ENFORCED = 'true';
        expect(uploadTokenEnforced()).toBe(true);
        process.env.UPLOAD_TOKEN_ENFORCED = 'false';
        expect(uploadTokenEnforced()).toBe(false);
    });
});
