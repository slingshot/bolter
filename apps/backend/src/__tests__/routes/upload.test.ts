import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import type { FileMetadata } from '../../storage';

// ---------------------------------------------------------------------------
// Mocks — must be registered BEFORE any module that transitively imports them
// ---------------------------------------------------------------------------

const mockRedis = {
    ping: mock(() => Promise.resolve(true)),
    hSet: mock(() => Promise.resolve()),
    hSetIfExists: mock(() => Promise.resolve(true)),
    hGet: mock(() => Promise.resolve(null as string | null)),
    hGetAll: mock(() => Promise.resolve(null as Record<string, string> | null)),
    hDel: mock(() => Promise.resolve()),
    expire: mock(() => Promise.resolve()),
    del: mock(() => Promise.resolve()),
    exists: mock(() => Promise.resolve(false)),
    ttl: mock(() => Promise.resolve(-1)),
    hIncrBy: mock(() => Promise.resolve(0)),
};

/** Fields written by the single EXISTS-guarded finalization call, if any */
function finalizedFields(): Record<string, string> {
    const call = mockRedis.hSetIfExists.mock.calls[0] as unknown[] | undefined;
    return (call?.[1] as Record<string, string>) ?? {};
}

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
    getActiveProviderId: mock(() => 'default'),
};

mock.module('../../storage', () => ({ storage: mockStorage }));
mock.module('../../storage/index', () => ({ storage: mockStorage }));
mock.module('../../storage/redis', () => ({ redis: mockRedis, RedisStorage: class {} }));
mock.module('../../storage/provider-registry', () => ({
    providerRegistry: {
        incrementFileCount: mock(() => Promise.resolve()),
        decrementFileCount: mock(() => Promise.resolve()),
        getActiveProviderId: mock(() => 'default'),
    },
}));
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

// Recording logger — several regression tests assert that secrets (owner
// tokens, pre-signed URLs) never reach a log record
const loggedObjects: Record<string, unknown>[] = [];
function recordLog(obj: unknown) {
    if (obj && typeof obj === 'object') {
        loggedObjects.push(obj as Record<string, unknown>);
    }
}
const noopLogger = {
    info: recordLog,
    warn: recordLog,
    error: recordLog,
    debug: recordLog,
    child: () => noopLogger,
};
mock.module('../../logger', () => ({
    logger: noopLogger,
    uploadLogger: noopLogger,
    downloadLogger: noopLogger,
    storageLogger: noopLogger,
    s3Logger: noopLogger,
    reaperLogger: noopLogger,
    redactPaths: [],
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { Elysia } from 'elysia';
import { REAP_KEY } from '../../reaper';
import { speedTestRateLimiter, uploadRoutes } from '../../routes/upload';

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

function setFieldValues(field: string): string[] {
    return mockStorage.setField.mock.calls
        .filter((call: unknown[]) => call[1] === field)
        .map((call: unknown[]) => call[2] as string);
}

/** Reap records written through redis.hSet(REAP_KEY, id, json) */
function reapRecords(): Record<string, unknown>[] {
    return mockRedis.hSet.mock.calls
        .filter((call: unknown[]) => call[0] === REAP_KEY)
        .map((call: unknown[]) => JSON.parse(call[2] as string) as Record<string, unknown>);
}

const UPLOAD_TOKEN = 'a'.repeat(32);
const UPLOAD_TOKEN_HASH = createHash('sha256').update(UPLOAD_TOKEN).digest('hex');

/**
 * Run `fn` with the upload-token rollout flag forced on, then restore it.
 * Unset (the default) means log-but-allow, so the shipped client — which does
 * not send `uploadToken` yet — keeps working.
 */
async function withUploadTokenEnforced<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = process.env.UPLOAD_TOKEN_ENFORCED;
    process.env.UPLOAD_TOKEN_ENFORCED = 'true';
    try {
        return await fn();
    } finally {
        if (previous === undefined) {
            delete process.env.UPLOAD_TOKEN_ENFORCED;
        } else {
            process.env.UPLOAD_TOKEN_ENFORCED = previous;
        }
    }
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
        mockStorage.del.mockReset();
        mockStorage.del.mockResolvedValue(undefined);
        mockStorage.abortMultipartUpload.mockReset();
        mockStorage.abortMultipartUpload.mockResolvedValue(undefined);
        mockRedis.expire.mockReset();
        mockRedis.expire.mockResolvedValue(undefined);
        mockRedis.hSet.mockReset();
        mockRedis.hSet.mockResolvedValue(undefined);
        loggedObjects.length = 0;
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

    // Returned as HTTP 200 these bodies sailed through the client's
    // `response.ok` guard, which then reported the unrelated
    // "Pre-signed URLs not available" instead of the real reason
    it('should return HTTP 400 (not 200) for file size of 0', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 0 }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBeDefined();
        expect(body.error).toContain('Invalid file size');
    });

    it('should return HTTP 400 (not 200) for negative file size', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: -100 }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Invalid file size');
    });

    it('should return HTTP 400 (not 200) for file exceeding MAX_FILE_SIZE', async () => {
        const app = createApp();
        // MAX_FILE_SIZE is 1TB = 1_000_000_000_000
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 2_000_000_000_000 }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('File size exceeds maximum');
    });

    it('should not create any metadata or S3 state for a rejected size', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 0 }));

        expect(mockStorage.setField.mock.calls.length).toBe(0);
        expect(mockStorage.createMultipartUpload.mock.calls.length).toBe(0);
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

    it('should roll back metadata (storage.del) when multipart creation fails', async () => {
        mockStorage.createMultipartUpload.mockResolvedValueOnce(null);

        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));

        // storage.del decrements the provider file counter incremented earlier —
        // without it the counter drifts and orphan metadata lingers until TTL
        expect(mockStorage.del.mock.calls.length).toBe(1);
    });

    it('should abort the upload and roll back when part URL signing fails', async () => {
        mockStorage.getSignedMultipartUploadUrl.mockRejectedValue(new Error('S3 down'));

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.useSignedUrl).toBe(false);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(1);
        expect(mockStorage.del.mock.calls.length).toBe(1);
    });

    it('should return useSignedUrl=false and roll back when single-part signing returns null', async () => {
        // First call is the presign health test (succeeds), second is the real URL
        mockStorage.getSignedUploadUrl
            .mockResolvedValueOnce('https://s3.example.com/upload?signed=true')
            .mockResolvedValueOnce(null);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000 }));

        expect(res.status).toBe(200);
        const body = await res.json();
        // Must never respond with { useSignedUrl: true, url: null }
        expect(body.useSignedUrl).toBe(false);
        expect(body.url ?? null).toBeNull();
        expect(mockStorage.del.mock.calls.length).toBe(1);
    });

    it('should pin every multipart operation to the provider captured at request start', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));

        // createMultipartUpload(id, objectExpires, providerId)
        expect(mockStorage.createMultipartUpload.mock.calls[0][2]).toBe('default');
        // getSignedMultipartUploadUrl(id, uploadId, partNumber, expiresIn, providerId)
        for (const call of mockStorage.getSignedMultipartUploadUrl.mock.calls) {
            expect(call[4]).toBe('default');
        }
    });

    it('should sign the single-part URL with the 7-day expiry and pinned provider', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000 }));

        // Second call is the real upload URL (first is the presign health test)
        const call = mockStorage.getSignedUploadUrl.mock.calls[1] as unknown[];
        expect(call[1]).toBe(7 * 24 * 60 * 60); // expiresIn, not the 1h default
        expect(call[3]).toBe('default'); // providerId pinned
    });

    // --- #35: secrets must never reach a log record --------------------------

    it('should never log the owner token', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000 }));
        const body = await res.json();

        expect(body.owner).toBeDefined();
        // Log-read access must not become delete/params/password authority
        for (const record of loggedObjects) {
            expect(Object.keys(record)).not.toContain('owner');
            expect(JSON.stringify(record)).not.toContain(body.owner);
        }
    });

    it('should never log a pre-signed upload URL (single-part or multipart)', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000 }));
        await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));

        // A pre-signed URL's query string is a valid AWS signature — replaying
        // it overwrites the stored object for the URL's whole validity window
        for (const record of loggedObjects) {
            const serialized = JSON.stringify(record);
            expect(serialized).not.toContain('signed=true');
            expect(serialized).not.toContain('s3.example.com');
        }
    });

    it('should never log the upload-owner token', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));
        const body = await res.json();

        expect(body.uploadToken).toBeDefined();
        for (const record of loggedObjects) {
            expect(JSON.stringify(record)).not.toContain(body.uploadToken);
        }
    });

    // --- #5: dlimit validation / clamping ------------------------------------

    it('should clamp an oversized dlimit to config.maxDownloads', async () => {
        const app = createApp();
        // Unclamped this makes the `dl >= dlimit` gate unreachable — unlimited
        // downloads for the whole expiry window
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000, dlimit: 1_000_000_000 }));

        expect(setFieldValues('dlimit')).toEqual(['100']); // DOWNLOAD_LIMITS.MAX_DOWNLOADS
    });

    it('should store the default dlimit when none is supplied', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000 }));

        expect(setFieldValues('dlimit')).toEqual(['1']);
    });

    it('should store an in-range dlimit verbatim as an integer string', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000, dlimit: 20 }));

        expect(setFieldValues('dlimit')).toEqual(['20']);
    });

    it('should reject a negative dlimit at the schema instead of bricking the file', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000, dlimit: -1 }));

        expect(res.status).toBe(422);
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should reject a fractional dlimit', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/url', { fileSize: 50_000_000, dlimit: 2.5 }),
        );

        expect(res.status).toBe(422);
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should never store a dlimit in exponential notation', async () => {
        const app = createApp();
        // 1e21 stringifies as '1e+21', which reads back through parseInt as 1 —
        // silently turning the file into a single-use self-destruct
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000, dlimit: 1e21 }));

        const stored = setFieldValues('dlimit');
        expect(stored).toEqual(['100']);
        expect(stored[0]).not.toContain('e');
    });

    // --- #7: timeLimit must never reach EXPIRE as a delete -------------------

    it('should reject a negative timeLimit (EXPIRE with a negative TTL deletes the key)', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/url', { fileSize: 50_000_000, timeLimit: -1 }),
        );

        expect(res.status).toBe(422);
        expect(mockRedis.expire.mock.calls.length).toBe(0);
    });

    it('should reject a zero timeLimit', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/url', { fileSize: 50_000_000, timeLimit: 0 }),
        );

        expect(res.status).toBe(422);
        expect(mockRedis.expire.mock.calls.length).toBe(0);
    });

    it('should always call EXPIRE with a positive TTL', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000, timeLimit: 3600 }));

        const ttl = mockRedis.expire.mock.calls[0][1] as number;
        expect(ttl).toBe(3600);
        expect(ttl).toBeGreaterThan(0);
    });

    // --- #23: rollback must cover the post-signing Redis writes --------------

    it('should abort the S3 multipart and roll back when a post-signing Redis write fails', async () => {
        mockStorage.setField.mockImplementation((_id: string, field: string) =>
            field === 'uploadId'
                ? Promise.reject(new Error('redis blip'))
                : Promise.resolve(undefined),
        );

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));

        // Previously this threw out of the handler: 500 with no id/uploadId for
        // the client to clean up, an orphaned S3 multipart, and a +1 provider count
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.useSignedUrl).toBe(false);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(1);
        expect(mockStorage.del.mock.calls.length).toBe(1);
    });

    // --- #42: every created object is registered for reaping ----------------

    it('should register a single-part upload for reaping with its pinned provider', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 50_000_000, timeLimit: 3600 }));

        const records = reapRecords();
        expect(records.length).toBe(1);
        expect(records[0].kind).toBe('file');
        expect(records[0].providerId).toBe('default');
        // Roughly now + 1h; the reap deadline must track the metadata TTL
        expect(records[0].expiresAt as number).toBeGreaterThan(Date.now() + 3_500_000);
    });

    it('should register a multipart upload for reaping including its uploadId', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/url', { fileSize: 500_000_000 }));

        const records = reapRecords();
        expect(records.length).toBe(1);
        // Without the uploadId an abandoned multipart's parts can never be aborted
        expect(records[0].uploadId).toBe('test-upload-id');
        expect(records[0].providerId).toBe('default');
    });
});

describe('POST /upload/complete', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.setField.mockReset();
        mockStorage.setField.mockResolvedValue(undefined);
        mockStorage.completeMultipartUpload.mockReset();
        mockStorage.completeMultipartUpload.mockResolvedValue(undefined);
        mockStorage.length.mockReset();
        mockStorage.length.mockResolvedValue(0);
        mockStorage.del.mockReset();
        mockStorage.del.mockResolvedValue(undefined);
        mockStorage.getTTL.mockReset();
        mockStorage.getTTL.mockResolvedValue(-1);
        mockRedis.hDel.mockReset();
        mockRedis.hDel.mockResolvedValue(undefined);
        mockRedis.hSetIfExists.mockReset();
        mockRedis.hSetIfExists.mockResolvedValue(true);
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
        // The owner token must never be embedded as a URL fragment
        expect(body.url).not.toContain('#');

        // Should NOT have called completeMultipartUpload
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(0);

        // Should have stored auth as 'unencrypted'
        expect(finalizedFields().auth).toBe('unencrypted');
    });

    it('rejects metadata past the byte cap before completing the upload', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 1 }),
        );

        // Base64 is ASCII, so length is byte length. The stored blob is
        // re-served by /metadata/:id on every download-page load, and neither
        // the route schema (`t.String()`) nor Bun's 128MB body default bounded
        // it — a single POST could park megabytes in Redis behind one file id.
        const oversized = 'A'.repeat(2 * 1024 * 1024);

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/complete', {
                id: 'abc123',
                metadata: oversized,
                parts: [{ PartNumber: 1, ETag: '"etag1"' }],
            }),
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/metadata/i);
        // Refused before the S3 completion, like the file-count gate: a
        // rejected upload must never be finalized.
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(0);
    });

    it('caps encrypted metadata too, which the file-count gate cannot inspect', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: true, multipart: false }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/complete', {
                id: 'abc123',
                metadata: 'A'.repeat(2 * 1024 * 1024),
                authKey: 'a'.repeat(43),
            }),
        );

        // MAX_FILES_PER_ARCHIVE is unenforceable on ciphertext by design. A
        // byte cap is not — it is the one bound that covers both share types.
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/metadata/i);
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

    it('should return 400 for encrypted file without authKey', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: true }));

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Missing or invalid auth key');
    });

    it('should reject missing authKey BEFORE completing the S3 multipart upload', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                encrypted: true,
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Missing or invalid auth key');
        // The object must not be finalized — it would be permanently 401
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(0);
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

        // Should have stored auth key and a non-empty base64 nonce, in one
        // EXISTS-guarded write
        expect(mockRedis.hSetIfExists.mock.calls.length).toBe(1);
        expect(finalizedFields().auth).toBe('dGVzdC1hdXRoLWtleQ==');
        expect(finalizedFields().nonce).toBeTruthy();
    });

    it('should store auth as "unencrypted" for unencrypted file', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));

        const app = createApp();
        await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        expect(finalizedFields().auth).toBe('unencrypted');
        expect(finalizedFields().nonce).toBe('');
    });

    it('should reject re-completion of an encrypted file with a different authKey', async () => {
        // Simulates an attacker who learned the file ID from a shared link and
        // tries to overwrite the auth key (locking out recipients) or metadata
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: true, auth: 'original-auth-key', nonce: 'nonce' }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/complete', {
                id: 'abc123',
                authKey: 'attacker-auth-key',
                metadata: 'attacker-metadata',
            }),
        );

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toContain('already completed');
        // Nothing may be overwritten
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should treat re-completion with the same authKey as an idempotent retry', async () => {
        // A client that lost the response to its first /upload/complete POST
        // retries with identical payload — must succeed without rewriting state
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: true, auth: 'original-auth-key', nonce: 'nonce' }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/complete', {
                id: 'abc123',
                authKey: 'original-auth-key',
                metadata: 'same-metadata',
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.url).toContain('/download/abc123');
        // Idempotent: no fields rewritten, no nonce rotation
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should treat re-completion of an unencrypted file as an idempotent retry', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, auth: 'unencrypted', metadata: 'original' }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/complete', { id: 'abc123', metadata: 'attacker-metadata' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        // Stored metadata must not be overwritten
        expect(mockStorage.setField.mock.calls.length).toBe(0);
    });

    it('should return 400 when file ID is missing', async () => {
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: '' }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Missing file ID');
    });

    it('should return 404 when file not found', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'nonexistent' }));

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
        // Legacy body status field is preserved for older clients
        expect(body.status).toBe(404);
    });

    it('should return 400 when parts data is missing for a multipart upload', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Missing parts data');
    });

    it('should return 500 when upload ID is missing from metadata', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: undefined,
                numParts: 2,
            }),
        );

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toContain('Upload ID not found');
    });

    it('should fall back to actualSize under fileSize when the object HEAD is unavailable', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));
        mockStorage.length.mockRejectedValue(new Error('HEAD failed'));

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/complete', { id: 'abc123', actualSize: 12345678 }),
        );

        expect(res.status).toBe(200);
        expect(finalizedFields().fileSize).toBe('12345678');
        expect(finalizedFields().size).toBeUndefined();
    });

    it('should return 400 when too many parts are sent', async () => {
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

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Too many parts');
    });

    it('should return 400 when part numbers have a gap (missing data)', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 4 }),
        );

        // Part 3 missing — S3 would complete this into a silently corrupt object
        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
            { PartNumber: 4, ETag: '"etag4"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('contiguous');
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(0);
    });

    it('should return 400 when part numbers contain duplicates', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 3 }),
        );

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2a"' },
            { PartNumber: 2, ETag: '"etag2b"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(400);
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(0);
    });

    it('should return 400 when part numbers do not start at 1', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 3 }),
        );

        const parts = [
            { PartNumber: 2, ETag: '"etag2"' },
            { PartNumber: 3, ETag: '"etag3"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(400);
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(0);
    });

    it('should return 400 for an empty parts array instead of a cryptic S3 error', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 2 }),
        );

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts: [] }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Missing parts data');
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(0);
    });

    it('should allow completion with fewer parts than allocated (stream ended early)', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 5 }),
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
        expect(body.success).toBe(true);
        expect(mockStorage.completeMultipartUpload.mock.calls.length).toBe(1);
    });

    it('should finish completion when NoSuchUpload hides an already-finalized object', async () => {
        // CompleteMultipartUpload committed on a previous attempt (lost response
        // or SDK-internal retry) — S3 reports the uploadId as gone, but the
        // object exists. The route must finalize auth/metadata, not 404, or
        // the fully-uploaded file is permanently dead.
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 2 }),
        );
        const err = new Error('NoSuchUpload');
        err.name = 'NoSuchUpload';
        mockStorage.completeMultipartUpload.mockRejectedValue(err);
        mockStorage.length.mockResolvedValue(12_345_678); // object exists

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        // auth must have been stored so the file becomes downloadable
        expect(finalizedFields().auth).toBeTruthy();
    });

    it('should return 404 for NoSuchUpload error', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );
        // AWS SDK v3 puts S3 error codes in err.name, not err.code
        const err = new Error('NoSuchUpload') as Error & { code?: string };
        err.name = 'NoSuchUpload';
        mockStorage.completeMultipartUpload.mockRejectedValue(err);

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('Upload not found or expired');
        // Legacy body status field is preserved for older clients
        expect(body.status).toBe(404);
    });

    it('should return 400 for InvalidPart error', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );
        // AWS SDK v3 puts S3 error codes in err.name, not err.code
        const err = new Error('InvalidPart') as Error & { code?: string };
        err.name = 'InvalidPart';
        mockStorage.completeMultipartUpload.mockRejectedValue(err);

        const parts = [
            { PartNumber: 1, ETag: '"bad-etag"' },
            { PartNumber: 2, ETag: '"bad-etag"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Invalid upload parts');
        expect(body.status).toBe(400);
    });

    it('should return 400 for EntityTooSmall error', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({
                multipart: true,
                uploadId: 'mp-upload-id',
                numParts: 2,
            }),
        );
        // AWS SDK v3 puts S3 error codes in err.name, not err.code
        const err = new Error('EntityTooSmall') as Error & { code?: string };
        err.name = 'EntityTooSmall';
        mockStorage.completeMultipartUpload.mockRejectedValue(err);

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('smaller than the 5MB minimum');
        expect(body.status).toBe(400);
    });

    // --- #36: the limit binds to real stored bytes ---------------------------

    it('should reject and delete an object whose stored size exceeds MAX_FILE_SIZE', async () => {
        // Attacker declared a tiny fileSize at /upload/url, then PUT 50TB to the
        // pre-signed URL (which constrains only Bucket/Key) and reports a small
        // actualSize here
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));
        mockStorage.length.mockResolvedValue(50_000_000_000_000);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', actualSize: 1 }));

        expect(res.status).toBe(413);
        const body = await res.json();
        expect(body.error).toContain('exceeds maximum');
        // The over-size bytes must not stay billable/downloadable
        expect(mockStorage.del.mock.calls.length).toBe(1);
        expect(mockStorage.del.mock.calls[0][0]).toBe('abc123');
        // And the file must never be finalized into a downloadable state
        expect(mockRedis.hSetIfExists.mock.calls.length).toBe(0);
    });

    it('should derive the stored fileSize from the object HEAD, not the client claim', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));
        mockStorage.length.mockResolvedValue(987_654_321);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', actualSize: 1 }));

        expect(res.status).toBe(200);
        expect(finalizedFields().fileSize).toBe('987654321');
    });

    it('should accept a stored size exactly at MAX_FILE_SIZE', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));
        mockStorage.length.mockResolvedValue(1_000_000_000_000); // 1TB

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        expect(res.status).toBe(200);
        expect(finalizedFields().fileSize).toBe('1000000000000');
    });

    // --- #7: finalization must not resurrect an expired key ------------------

    it('should 404 instead of resurrecting metadata that expired during completion', async () => {
        // A long CompleteMultipartUpload can straddle a short TTL. An unguarded
        // HSET recreates the hash with NO TTL, no owner and no providerId —
        // an immortal, undeletable, mis-routed file.
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 2 }),
        );
        mockRedis.hSetIfExists.mockResolvedValue(false);

        const parts = [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ];

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123', parts }));

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toContain('File not found');
    });

    it('should write every finalization field in ONE EXISTS-guarded call', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));
        mockStorage.length.mockResolvedValue(4242);

        const app = createApp();
        await app.handle(jsonPost('/upload/complete', { id: 'abc123', metadata: 'bWV0YQ==' }));

        // Unguarded per-field setField writes are what resurrect an expired key
        expect(mockStorage.setField.mock.calls.length).toBe(0);
        expect(mockRedis.hSetIfExists.mock.calls.length).toBe(1);
        expect(finalizedFields()).toEqual({
            metadata: 'bWV0YQ==',
            auth: 'unencrypted',
            nonce: '',
            fileSize: '4242',
        });
    });

    // --- #15: the server owns the expiry -------------------------------------

    it('should return the authoritative remaining lifetime from the Redis TTL', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));
        mockStorage.getTTL.mockResolvedValue(3600);

        const before = Date.now();
        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        expect(res.status).toBe(200);
        const body = await res.json();
        // The TTL started at /upload/url — a client computing now + timeLimit
        // would show an expiry the server will not honor
        expect(body.ttl).toBe(3600);
        expect(body.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
        expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
        expect(mockStorage.getTTL.mock.calls[0][0]).toBe('abc123');
    });

    it('should report a zero lifetime rather than "forever" when no TTL is set', async () => {
        mockStorage.getMetadata.mockResolvedValue(makeMetadata({ encrypted: false }));
        mockStorage.getTTL.mockResolvedValue(-1);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        const body = await res.json();
        expect(body.ttl).toBe(0);
    });

    it('should return the remaining lifetime on an idempotent re-completion too', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ encrypted: false, auth: 'unencrypted' }),
        );
        mockStorage.getTTL.mockResolvedValue(120);

        const app = createApp();
        const res = await app.handle(jsonPost('/upload/complete', { id: 'abc123' }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ttl).toBe(120);
        // Still idempotent — nothing rewritten
        expect(mockRedis.hSetIfExists.mock.calls.length).toBe(0);
    });
});

describe('POST /upload/abort/:id', () => {
    beforeEach(() => {
        mockStorage.abortMultipartUpload.mockReset();
        mockStorage.abortMultipartUpload.mockResolvedValue(undefined);
        mockStorage.del.mockReset();
        mockStorage.del.mockResolvedValue(undefined);
        mockStorage.getMetadata.mockReset();
        mockStorage.getMetadata.mockResolvedValue(null);
        mockStorage.getField.mockReset();
        mockStorage.getField.mockResolvedValue(null);
        mockRedis.hDel.mockReset();
        mockRedis.hDel.mockResolvedValue(undefined);
        loggedObjects.length = 0;
    });

    // --- #52: abort must be bound to the upload owner -----------------------

    it('should still abort when the client sends no upload token (default rollout mode)', async () => {
        // The shipped client posts exactly `{ uploadId }` and never checks
        // response.ok, so a 401 here silently strands the S3 multipart, the
        // metadata, and the provider file counter. Until the client sends the
        // token, an unverified abort is logged and allowed.
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id' }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/abort/abc123', { uploadId: 'mp-upload-id' }),
        );

        expect(res.status).toBe(200);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(1);
        expect(mockStorage.del.mock.calls.length).toBe(1);

        // ...but the drop is observable, so the rollout can be verified before
        // UPLOAD_TOKEN_ENFORCED is flipped on
        const warned = loggedObjects.some((o) => o.route === 'abort' && o.tokenPresent === false);
        expect(warned).toBe(true);
    });

    it('should reject an abort with no upload token once enforcement is on', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id' }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const res = await withUploadTokenEnforced(() => {
            const app = createApp();
            return app.handle(jsonPost('/upload/abort/abc123', { uploadId: 'mp-upload-id' }));
        });

        // A leaked uploadId alone must not let a third party kill the upload
        expect(res.status).toBe(401);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(0);
        expect(mockStorage.del.mock.calls.length).toBe(0);
    });

    it('should reject an abort with the wrong upload token once enforcement is on', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id' }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const res = await withUploadTokenEnforced(() => {
            const app = createApp();
            return app.handle(
                jsonPost('/upload/abort/abc123', {
                    uploadId: 'mp-upload-id',
                    uploadToken: 'b'.repeat(32),
                }),
            );
        });

        expect(res.status).toBe(401);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(0);
    });

    it('should never log the supplied upload token', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id' }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const app = createApp();
        await app.handle(
            jsonPost('/upload/abort/abc123', {
                uploadId: 'mp-upload-id',
                uploadToken: 'c'.repeat(32),
            }),
        );

        expect(JSON.stringify(loggedObjects)).not.toContain('c'.repeat(32));
    });

    it('should accept an abort carrying the correct upload token', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id' }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const res = await withUploadTokenEnforced(() => {
            const app = createApp();
            return app.handle(
                jsonPost('/upload/abort/abc123', {
                    uploadId: 'mp-upload-id',
                    uploadToken: UPLOAD_TOKEN,
                }),
            );
        });

        expect(res.status).toBe(200);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(1);
    });

    it('should reject an abort whose uploadId does not match the stored one', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'real-upload-id' }),
        );

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/abort/abc123', { uploadId: 'attacker-upload-id' }),
        );

        // The uploadId was previously passed straight through to S3 unverified
        expect(res.status).toBe(400);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(0);
    });

    it('should still abort uploads created before upload tokens existed', async () => {
        // Backward compatibility: an in-flight upload from before the deploy has
        // no stored hash, and must remain abortable even with enforcement on
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id' }),
        );
        mockStorage.getField.mockResolvedValue(null);

        const res = await withUploadTokenEnforced(() => {
            const app = createApp();
            return app.handle(jsonPost('/upload/abort/abc123', { uploadId: 'mp-upload-id' }));
        });

        expect(res.status).toBe(200);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(1);
    });

    it('should drop the reap record after a successful abort', async () => {
        const app = createApp();
        await app.handle(jsonPost('/upload/abort/abc123', { uploadId: 'mp-upload-id' }));

        const reapDeletes = mockRedis.hDel.mock.calls.filter(
            (call: unknown[]) => call[0] === REAP_KEY,
        );
        expect(reapDeletes.length).toBe(1);
    });

    it('should abort upload and clean up storage (decrementing provider counter)', async () => {
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

        // storage.del handles redis cleanup AND the provider file-count
        // decrement that balances the increment made at /upload/url
        expect(mockStorage.del.mock.calls.length).toBe(1);
        expect(mockStorage.del.mock.calls[0][0]).toBe('abc123');
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
        mockStorage.getField.mockReset();
        mockStorage.getField.mockResolvedValue(null);
        mockStorage.getSignedMultipartUploadUrl.mockReset();
        mockStorage.getSignedMultipartUploadUrl.mockResolvedValue(
            'https://s3.example.com/part?signed=true',
        );
        loggedObjects.length = 0;
    });

    // --- #52: resume must be bound to the upload owner ----------------------

    it('should still resume when the client sends no upload token (default rollout mode)', async () => {
        // The shipped client posts exactly `{ uploadId, completedPartNumbers }`
        // and treats ANY non-OK response as fatal: it deletes the IndexedDB
        // resume state and throws "Upload session expired", orphaning the S3
        // multipart. Rejecting by default would kill resumability outright.
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 3 }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/multipart/abc123/resume', {
                uploadId: 'mp-upload-id',
                completedPartNumbers: [1],
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.parts.length).toBe(2);

        const warned = loggedObjects.some((o) => o.route === 'resume' && o.tokenPresent === false);
        expect(warned).toBe(true);
    });

    it('should reject a resume with no upload token once enforcement is on', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 5 }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const res = await withUploadTokenEnforced(() => {
            const app = createApp();
            return app.handle(
                jsonPost('/upload/multipart/abc123/resume', {
                    uploadId: 'mp-upload-id',
                    completedPartNumbers: [1],
                }),
            );
        });

        // Otherwise a leaked uploadId mints fresh pre-signed PUT URLs for every
        // unfinished part — arbitrary bytes injected before the uploader completes
        expect(res.status).toBe(401);
        expect(mockStorage.getSignedMultipartUploadUrl.mock.calls.length).toBe(0);
    });

    it('should reject a resume with the wrong upload token once enforcement is on', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 5 }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const res = await withUploadTokenEnforced(() => {
            const app = createApp();
            return app.handle(
                jsonPost('/upload/multipart/abc123/resume', {
                    uploadId: 'mp-upload-id',
                    uploadToken: 'b'.repeat(32),
                    completedPartNumbers: [],
                }),
            );
        });

        expect(res.status).toBe(401);
        expect(mockStorage.getSignedMultipartUploadUrl.mock.calls.length).toBe(0);
    });

    it('should accept a resume carrying the correct upload token', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 3 }),
        );
        mockStorage.getField.mockResolvedValue(UPLOAD_TOKEN_HASH);

        const res = await withUploadTokenEnforced(() => {
            const app = createApp();
            return app.handle(
                jsonPost('/upload/multipart/abc123/resume', {
                    uploadId: 'mp-upload-id',
                    uploadToken: UPLOAD_TOKEN,
                    completedPartNumbers: [1],
                }),
            );
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.parts.length).toBe(2);
    });

    it('should still resume uploads created before upload tokens existed', async () => {
        mockStorage.getMetadata.mockResolvedValue(
            makeMetadata({ multipart: true, uploadId: 'mp-upload-id', numParts: 3 }),
        );
        mockStorage.getField.mockResolvedValue(null);

        const res = await withUploadTokenEnforced(() => {
            const app = createApp();
            return app.handle(
                jsonPost('/upload/multipart/abc123/resume', {
                    uploadId: 'mp-upload-id',
                    completedPartNumbers: [1, 2],
                }),
            );
        });

        expect(res.status).toBe(200);
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
        mockStorage.abortMultipartUpload.mockReset();
        mockStorage.abortMultipartUpload.mockResolvedValue(undefined);
        mockRedis.hSet.mockReset();
        mockRedis.hSet.mockResolvedValue(undefined);
        speedTestRateLimiter.reset();
    });

    // --- #11: unauthenticated write amplification ---------------------------

    it('should rate limit repeated speed tests from the same client', async () => {
        const app = createApp();
        const headers = { 'cf-connecting-ip': '203.0.113.9' };
        const statuses: number[] = [];

        for (let i = 0; i < 6; i++) {
            const res = await app.handle(
                new Request('http://localhost/upload/speedtest', { method: 'POST', headers }),
            );
            statuses.push(res.status);
        }

        // Each accepted call mints 5 unbounded pre-signed UploadPart URLs
        expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
        expect(statuses[5]).toBe(429);
        expect(mockStorage.createMultipartUpload.mock.calls.length).toBe(5);
    });

    it('should rate limit per client IP, not globally', async () => {
        const app = createApp();
        for (let i = 0; i < 5; i++) {
            await app.handle(
                new Request('http://localhost/upload/speedtest', {
                    method: 'POST',
                    headers: { 'cf-connecting-ip': '203.0.113.9' },
                }),
            );
        }

        const other = await app.handle(
            new Request('http://localhost/upload/speedtest', {
                method: 'POST',
                headers: { 'cf-connecting-ip': '198.51.100.4' },
            }),
        );
        expect(other.status).toBe(200);
    });

    it('should pin the speed test to the active provider', async () => {
        const app = createApp();
        await app.handle(new Request('http://localhost/upload/speedtest', { method: 'POST' }));

        // createMultipartUpload(id, objectExpires, providerId)
        expect(mockStorage.createMultipartUpload.mock.calls[0][2]).toBe('default');
        for (const call of mockStorage.getSignedMultipartUploadUrl.mock.calls) {
            expect(call[4]).toBe('default');
        }
    });

    it('should register the speed test for server-side sweeping', async () => {
        const app = createApp();
        await app.handle(new Request('http://localhost/upload/speedtest', { method: 'POST' }));

        // Cleanup must not depend on the client ever coming back
        const records = reapRecords();
        expect(records.length).toBe(1);
        expect(records[0].kind).toBe('speedtest');
        expect(records[0].uploadId).toBe('test-upload-id');
        expect(records[0].providerId).toBe('default');
    });

    it('should abort the created multipart when part signing fails', async () => {
        mockStorage.getSignedMultipartUploadUrl.mockRejectedValue(new Error('S3 down'));

        const app = createApp();
        const res = await app.handle(
            new Request('http://localhost/upload/speedtest', { method: 'POST' }),
        );

        const body = await res.json();
        expect(body.error).toContain('Speed test setup failed');
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(1);
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
        mockRedis.hGet.mockReset();
        mockRedis.hGet.mockResolvedValue(null);
        mockRedis.hDel.mockReset();
        mockRedis.hDel.mockResolvedValue(undefined);
    });

    it('should reject a cleanup for an id that is not a speed test', async () => {
        const app = createApp();
        const res = await app.handle(
            jsonPost('/upload/speedtest/cleanup', {
                testId: 'realfileid',
                uploadId: 'victim-upload-id',
            }),
        );

        // This route aborts an arbitrary uploadId — it must not accept real file ids
        expect(res.status).toBe(400);
        expect(mockStorage.abortMultipartUpload.mock.calls.length).toBe(0);
    });

    it('should abort against the provider pinned at creation time', async () => {
        mockRedis.hGet.mockResolvedValue(
            JSON.stringify({
                kind: 'speedtest',
                id: '__speedtest__abc123',
                providerId: 'backup-provider',
                uploadId: 'test-upload-id',
                expiresAt: Date.now() + 60_000,
            }),
        );

        const app = createApp();
        await app.handle(
            jsonPost('/upload/speedtest/cleanup', {
                testId: '__speedtest__abc123',
                uploadId: 'test-upload-id',
            }),
        );

        // Resolving "active" here aborts the wrong bucket after a provider change,
        // swallows the NoSuchUpload, and leaks the real test parts
        expect(mockStorage.abortMultipartUpload.mock.calls[0][2]).toBe('backup-provider');
    });

    it('should keep the sweep record when the abort fails so the reaper retries', async () => {
        mockStorage.abortMultipartUpload.mockRejectedValue(new Error('S3 error'));

        const app = createApp();
        await app.handle(
            jsonPost('/upload/speedtest/cleanup', {
                testId: '__speedtest__abc123',
                uploadId: 'test-upload-id',
            }),
        );

        const reapDeletes = mockRedis.hDel.mock.calls.filter(
            (call: unknown[]) => call[0] === REAP_KEY,
        );
        expect(reapDeletes.length).toBe(0);
    });

    it('should drop the sweep record after a successful cleanup', async () => {
        const app = createApp();
        await app.handle(
            jsonPost('/upload/speedtest/cleanup', {
                testId: '__speedtest__abc123',
                uploadId: 'test-upload-id',
            }),
        );

        const reapDeletes = mockRedis.hDel.mock.calls.filter(
            (call: unknown[]) => call[0] === REAP_KEY,
        );
        expect(reapDeletes.length).toBe(1);
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
