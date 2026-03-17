import { beforeEach, describe, expect, it, mock } from 'bun:test';

// --- Mock all storage dependencies before importing app ---

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

const mockS3 = {
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
};

const mockStorage = {
    redis: mockRedis,
    ping: mock(() => Promise.resolve({ redis: true, s3: true })),
    getMetadata: mock(() => Promise.resolve(null)),
    setField: mock(() => Promise.resolve()),
    getField: mock(() => Promise.resolve(null)),
    exists: mock(() => Promise.resolve(false)),
    del: mock(() => Promise.resolve()),
    incrementDownloadCount: mock(() => Promise.resolve(0)),
    getTTL: mock(() => Promise.resolve(-1)),
    getSignedUploadUrl: mock(() => Promise.resolve('https://fake-url')),
    getSignedDownloadUrl: mock(() => Promise.resolve('https://fake-url')),
    createMultipartUpload: mock(() => Promise.resolve('upload-id')),
    getSignedMultipartUploadUrl: mock(() => Promise.resolve('https://fake-part-url')),
    completeMultipartUpload: mock(() => Promise.resolve()),
    abortMultipartUpload: mock(() => Promise.resolve()),
    getStream: mock(() => Promise.resolve(null)),
    length: mock(() => Promise.resolve(0)),
};

// Mock all modules that connect to external services
mock.module('../storage', () => ({
    storage: mockStorage,
}));

mock.module('../storage/redis', () => ({
    redis: mockRedis,
    RedisStorage: class {},
}));

mock.module('../storage/s3', () => ({
    s3Storage: mockS3,
    S3Storage: class {},
}));

mock.module('../lib/sentry', () => ({
    captureError: mock(() => {
        /* noop */
    }),
    addBreadcrumb: mock(() => {
        /* noop */
    }),
}));

// Import app AFTER all mocks are in place
import { app } from '../app';

describe('GET /health', () => {
    beforeEach(() => {
        mockStorage.ping.mockReset();
    });

    it('should return 200 with healthy status when both services are up', async () => {
        mockStorage.ping.mockResolvedValue({ redis: true, s3: true });

        const res = await app.handle(new Request('http://localhost/health'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('healthy');
        expect(body.checks.redis).toBe('up');
        expect(body.checks.s3).toBe('up');
        expect(body.timestamp).toBeTruthy();
    });

    it('should return 503 when Redis is down', async () => {
        mockStorage.ping.mockResolvedValue({ redis: false, s3: true });

        const res = await app.handle(new Request('http://localhost/health'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe('unhealthy');
        expect(body.checks.redis).toBe('down');
        expect(body.checks.s3).toBe('up');
    });

    it('should return 503 when S3 is down', async () => {
        mockStorage.ping.mockResolvedValue({ redis: true, s3: false });

        const res = await app.handle(new Request('http://localhost/health'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe('unhealthy');
        expect(body.checks.redis).toBe('up');
        expect(body.checks.s3).toBe('down');
    });

    it('should return 503 when both services are down', async () => {
        mockStorage.ping.mockResolvedValue({ redis: false, s3: false });

        const res = await app.handle(new Request('http://localhost/health'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe('unhealthy');
        expect(body.checks.redis).toBe('down');
        expect(body.checks.s3).toBe('down');
    });
});

describe('GET /health/live', () => {
    it('should always return 200 with alive status', async () => {
        const res = await app.handle(new Request('http://localhost/health/live'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('alive');
        expect(body.timestamp).toBeTruthy();
    });

    it('should return a valid ISO timestamp', async () => {
        const res = await app.handle(new Request('http://localhost/health/live'));
        const body = await res.json();

        const parsedDate = new Date(body.timestamp);
        expect(parsedDate.getTime()).not.toBeNaN();
    });
});

describe('GET /health/ready', () => {
    beforeEach(() => {
        mockStorage.ping.mockReset();
    });

    it('should return 200 with ready status when both services are up', async () => {
        mockStorage.ping.mockResolvedValue({ redis: true, s3: true });

        const res = await app.handle(new Request('http://localhost/health/ready'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ready');
        expect(body.checks.redis).toBe('up');
        expect(body.checks.s3).toBe('up');
    });

    it('should return 503 with not_ready status when services are down', async () => {
        mockStorage.ping.mockResolvedValue({ redis: false, s3: false });

        const res = await app.handle(new Request('http://localhost/health/ready'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe('not_ready');
    });

    it('should return 503 when only Redis is down', async () => {
        mockStorage.ping.mockResolvedValue({ redis: false, s3: true });

        const res = await app.handle(new Request('http://localhost/health/ready'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe('not_ready');
        expect(body.checks.redis).toBe('down');
        expect(body.checks.s3).toBe('up');
    });
});

describe('GET /__version__', () => {
    it('should return version and name', async () => {
        const res = await app.handle(new Request('http://localhost/__version__'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.version).toBe('1.0.0');
        expect(body.name).toBe('bolter-backend');
    });
});

describe('GET /__heartbeat__', () => {
    beforeEach(() => {
        mockStorage.ping.mockReset();
    });

    it('should return ok status when healthy', async () => {
        mockStorage.ping.mockResolvedValue({ redis: true, s3: true });

        const res = await app.handle(new Request('http://localhost/__heartbeat__'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
        expect(body.redis).toBe(true);
        expect(body.s3).toBe(true);
    });

    it('should return error status when unhealthy', async () => {
        mockStorage.ping.mockResolvedValue({ redis: false, s3: true });

        const res = await app.handle(new Request('http://localhost/__heartbeat__'));

        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.redis).toBe(false);
        expect(body.s3).toBe(true);
    });
});

describe('GET /config', () => {
    it('should return expected configuration structure', async () => {
        const res = await app.handle(new Request('http://localhost/config'));

        expect(res.status).toBe(200);
        const body = await res.json();

        // Check LIMITS section exists with correct types
        expect(body.LIMITS).toBeDefined();
        expect(typeof body.LIMITS.MAX_FILE_SIZE).toBe('number');
        expect(typeof body.LIMITS.MAX_FILES_PER_ARCHIVE).toBe('number');
        expect(typeof body.LIMITS.MAX_EXPIRE_SECONDS).toBe('number');
        expect(typeof body.LIMITS.MAX_DOWNLOADS).toBe('number');

        // Check DEFAULTS section
        expect(body.DEFAULTS).toBeDefined();
        expect(typeof body.DEFAULTS.EXPIRE_SECONDS).toBe('number');
        expect(typeof body.DEFAULTS.DOWNLOADS).toBe('number');

        // Check UI section
        expect(body.UI).toBeDefined();
        expect(typeof body.UI.TITLE).toBe('string');
        expect(typeof body.UI.DESCRIPTION).toBe('string');
        expect(Array.isArray(body.UI.EXPIRE_TIMES)).toBe(true);
        expect(Array.isArray(body.UI.DOWNLOAD_COUNTS)).toBe(true);
    });

    it('should have positive numeric limits', async () => {
        const res = await app.handle(new Request('http://localhost/config'));
        const body = await res.json();

        expect(body.LIMITS.MAX_FILE_SIZE).toBeGreaterThan(0);
        expect(body.LIMITS.MAX_FILES_PER_ARCHIVE).toBeGreaterThan(0);
        expect(body.LIMITS.MAX_EXPIRE_SECONDS).toBeGreaterThan(0);
        expect(body.LIMITS.MAX_DOWNLOADS).toBeGreaterThan(0);
        expect(body.DEFAULTS.EXPIRE_SECONDS).toBeGreaterThan(0);
        expect(body.DEFAULTS.DOWNLOADS).toBeGreaterThan(0);
    });

    it('should have non-empty UI arrays', async () => {
        const res = await app.handle(new Request('http://localhost/config'));
        const body = await res.json();

        expect(body.UI.EXPIRE_TIMES.length).toBeGreaterThan(0);
        expect(body.UI.DOWNLOAD_COUNTS.length).toBeGreaterThan(0);
    });
});

describe('GET /robots.txt', () => {
    it('should disallow all crawlers', async () => {
        const res = await app.handle(new Request('http://localhost/robots.txt'));

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('User-agent: *');
        expect(text).toContain('Disallow: /');
    });
});
