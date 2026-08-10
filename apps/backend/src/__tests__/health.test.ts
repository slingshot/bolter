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

/**
 * Every registered provider, so a test can prove the health probe checks the
 * ACTIVE one only and never fans out across the whole registry.
 */
const registeredProviders = ['default', 'backup', 'archive', 'decommissioned'];

const mockProviderRegistry = {
    getActiveProviderId: mock(() => 'default'),
    getDefaultProviderId: mock(() => 'default'),
    healthCheckProvider: mock((_id: string) => Promise.resolve({ healthy: true, latencyMs: 1 })),
    healthCheckAll: mock(() =>
        Promise.resolve(Object.fromEntries(registeredProviders.map((id) => [id, true]))),
    ),
    listProviders: mock(() => Promise.resolve([])),
    initialize: mock(() => Promise.resolve()),
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

mock.module('../storage/provider-registry', () => ({
    providerRegistry: mockProviderRegistry,
    ProviderRegistry: class {},
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
import { getHealthTiming, resetHealthCache, setHealthTiming } from '../lib/health';

/**
 * Point every health dependency at a fixed verdict.
 *
 * Both the per-provider and the fan-out entry points are stubbed, so these
 * tests describe observable behaviour rather than one particular
 * implementation — the pre-fix `healthCheckAll()` version passes every test
 * outside the "finding #29" blocks below.
 */
function stubHealth({ redis: redisOk = true, s3 = true }: { redis?: boolean; s3?: boolean } = {}) {
    mockRedis.ping.mockImplementation(() => Promise.resolve(redisOk));
    mockProviderRegistry.healthCheckProvider.mockImplementation(() =>
        Promise.resolve({ healthy: s3, latencyMs: 1 }),
    );
    mockProviderRegistry.healthCheckAll.mockImplementation(() =>
        Promise.resolve(Object.fromEntries(registeredProviders.map((id) => [id, s3]))),
    );
}

/** Total storage probes issued, whichever entry point the app chose to use. */
function storageProbeCalls(): number {
    return (
        mockProviderRegistry.healthCheckProvider.mock.calls.length +
        mockProviderRegistry.healthCheckAll.mock.calls.length
    );
}

/** Make every storage health entry point hang, as a black-holing bucket would. */
function blackHoleStorage(): { release: () => void } {
    let release: () => void = () => {
        /* noop */
    };
    const hang = <T>(value: T) =>
        new Promise<T>((resolve) => {
            const previous = release;
            release = () => {
                previous();
                resolve(value);
            };
        });

    mockProviderRegistry.healthCheckProvider.mockImplementation(() =>
        hang({ healthy: true, latencyMs: 1 }),
    );
    mockProviderRegistry.healthCheckAll.mockImplementation(() =>
        hang(Object.fromEntries(registeredProviders.map((id) => [id, true]))),
    );

    return { release: () => release() };
}

function resetHealthMocks() {
    mockStorage.ping.mockReset();
    mockRedis.ping.mockReset();
    mockProviderRegistry.healthCheckProvider.mockReset();
    mockProviderRegistry.healthCheckAll.mockReset();
    mockProviderRegistry.getActiveProviderId.mockReset();
    mockProviderRegistry.getActiveProviderId.mockImplementation(() => 'default');
    resetHealthCache();
    stubHealth();
}

describe('GET /health', () => {
    beforeEach(resetHealthMocks);

    it('should return 200 with healthy status when both services are up', async () => {
        stubHealth({ redis: true, s3: true });

        const res = await app.handle(new Request('http://localhost/health'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('healthy');
        expect(body.checks.redis).toBe('up');
        expect(body.checks.s3).toBe('up');
        expect(body.timestamp).toBeTruthy();
    });

    it('should return 503 when Redis is down', async () => {
        stubHealth({ redis: false, s3: true });

        const res = await app.handle(new Request('http://localhost/health'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe('unhealthy');
        expect(body.checks.redis).toBe('down');
        expect(body.checks.s3).toBe('up');
    });

    it('should return 503 when S3 is down', async () => {
        stubHealth({ redis: true, s3: false });

        const res = await app.handle(new Request('http://localhost/health'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe('unhealthy');
        expect(body.checks.redis).toBe('up');
        expect(body.checks.s3).toBe('down');
    });

    it('should return 503 when both services are down', async () => {
        stubHealth({ redis: false, s3: false });

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
    beforeEach(resetHealthMocks);

    it('should return 200 with ready status when both services are up', async () => {
        stubHealth({ redis: true, s3: true });

        const res = await app.handle(new Request('http://localhost/health/ready'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ready');
        expect(body.checks.redis).toBe('up');
        expect(body.checks.s3).toBe('up');
    });

    it('should return 503 with not_ready status when services are down', async () => {
        stubHealth({ redis: false, s3: false });

        const res = await app.handle(new Request('http://localhost/health/ready'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe('not_ready');
    });

    it('should return 503 when only Redis is down', async () => {
        stubHealth({ redis: false, s3: true });

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
    beforeEach(resetHealthMocks);

    it('should return ok status when healthy', async () => {
        stubHealth({ redis: true, s3: true });

        const res = await app.handle(new Request('http://localhost/__heartbeat__'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
        expect(body.redis).toBe(true);
        expect(body.s3).toBe(true);
    });

    it('should return error status when unhealthy', async () => {
        stubHealth({ redis: false, s3: true });

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

// ---------------------------------------------------------------------------
// Finding #29 — unauthenticated health probes must not fan an untimed
// HeadBucket out to every registered provider on every single request.
//
// Two distinct harms, and both need covering:
//   (a) amplification — N providers × every request;
//   (b) head-of-line stalling — one black-holing provider hanging every probe.
// ---------------------------------------------------------------------------

describe('health probe amplification (finding #29)', () => {
    beforeEach(resetHealthMocks);

    it('reuses a cached ping across repeated /health probes', async () => {
        await app.handle(new Request('http://localhost/health'));
        await app.handle(new Request('http://localhost/health'));
        await app.handle(new Request('http://localhost/health'));

        expect(storageProbeCalls()).toBe(1);
        expect(mockRedis.ping).toHaveBeenCalledTimes(1);
    });

    it('shares one cached ping across the different probe endpoints', async () => {
        await app.handle(new Request('http://localhost/health'));
        await app.handle(new Request('http://localhost/health/ready'));
        await app.handle(new Request('http://localhost/__heartbeat__'));

        expect(storageProbeCalls()).toBe(1);
    });

    it('de-duplicates concurrent probes into a single upstream ping', async () => {
        const { release } = blackHoleStorage();

        const inflight = Promise.all([
            app.handle(new Request('http://localhost/health')),
            app.handle(new Request('http://localhost/health/ready')),
            app.handle(new Request('http://localhost/__heartbeat__')),
        ]);

        // Let the handlers reach the awaited ping before resolving it.
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();

        const responses = await inflight;

        expect(storageProbeCalls()).toBe(1);
        for (const res of responses) {
            expect(res.status).toBe(200);
        }
    });

    it('does not ping storage at all for the liveness probe', async () => {
        await app.handle(new Request('http://localhost/health/live'));

        expect(storageProbeCalls()).toBe(0);
        expect(mockRedis.ping).not.toHaveBeenCalled();
    });

    it('checks the active provider only, never the whole registry', async () => {
        mockProviderRegistry.getActiveProviderId.mockImplementation(() => 'backup');

        await app.handle(new Request('http://localhost/health/ready'));

        // Pre-fix this went through storage.ping() -> healthCheckAll(), one
        // HeadBucket per registered provider.
        expect(mockProviderRegistry.healthCheckAll).not.toHaveBeenCalled();
        expect(mockProviderRegistry.healthCheckProvider).toHaveBeenCalledTimes(1);
        expect(mockProviderRegistry.healthCheckProvider).toHaveBeenCalledWith('backup');
    });
});

describe('health probe stalling (finding #29)', () => {
    beforeEach(() => {
        resetHealthMocks();
        setHealthTiming({ cacheTtlMs: 20, probeTimeoutMs: 40 });
    });

    it('answers within the probe budget when the active provider black-holes', async () => {
        // A decommissioned bucket that never answers: the S3 client sets no
        // request timeout of its own, so without a bound here the probe hangs
        // for the socket timeout and readiness flaps.
        const { release } = blackHoleStorage();

        const started = Date.now();
        const res = await app.handle(new Request('http://localhost/health/ready'));
        const elapsed = Date.now() - started;

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.checks.s3).toBe('down');
        expect(body.checks.redis).toBe('up');
        expect(elapsed).toBeLessThan(1000);

        release();
    });

    it('does not let a hung refresh park probes that arrive behind it', async () => {
        // Warm the cache with a healthy result.
        const warm = await app.handle(new Request('http://localhost/health/ready'));
        expect(warm.status).toBe(200);

        // Let the cache expire, then make storage hang.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const { release } = blackHoleStorage();

        // The first caller triggers the refresh and waits (bounded); everyone
        // arriving behind it is served the last known result immediately
        // instead of queueing on the same dead socket.
        const refresher = app.handle(new Request('http://localhost/health/ready'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const follower = app.handle(new Request('http://localhost/health/ready'));

        const winner = await Promise.race([
            follower.then(() => 'follower'),
            refresher.then(() => 'refresher'),
        ]);
        expect(winner).toBe('follower');
        expect((await follower).status).toBe(200);

        release();
        await refresher;
    });

    it('reports storage down rather than 500ing when the probe itself throws', async () => {
        mockProviderRegistry.healthCheckProvider.mockImplementation(() =>
            Promise.reject(new Error('Provider "backup" not found')),
        );
        mockProviderRegistry.healthCheckAll.mockImplementation(() =>
            Promise.reject(new Error('Provider "backup" not found')),
        );

        const res = await app.handle(new Request('http://localhost/health'));

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.checks.s3).toBe('down');
    });
});

describe('health cache defaults (finding #29)', () => {
    beforeEach(resetHealthMocks);

    it('defaults to a TTL that actually covers a scheduled probe interval', () => {
        // A 5s TTL never hits when the shipped compose healthcheck polls every
        // 30s, so the periodic fan-out would be unchanged in production.
        expect(getHealthTiming().cacheTtlMs).toBeGreaterThanOrEqual(30_000);
    });

    it('bounds every dependency probe', () => {
        const { probeTimeoutMs } = getHealthTiming();
        expect(probeTimeoutMs).toBeGreaterThan(0);
        expect(probeTimeoutMs).toBeLessThanOrEqual(10_000);
    });
});

// ---------------------------------------------------------------------------
// Finding #6 — CORS must not reflect an arbitrary origin, and must never send
// `access-control-allow-credentials` outside an explicit development build.
// ---------------------------------------------------------------------------

describe('CORS fail-closed (finding #6)', () => {
    const evilOrigin = 'https://evil.example';

    it('does not reflect an arbitrary origin back to the caller', async () => {
        const res = await app.handle(
            new Request('http://localhost/config', { headers: { origin: evilOrigin } }),
        );

        expect(res.headers.get('access-control-allow-origin')).not.toBe(evilOrigin);
    });

    it('does not advertise credentialed cross-origin access', async () => {
        // Pre-fix `credentials: true` was unconditional, so every response
        // carried access-control-allow-credentials: true.
        const res = await app.handle(
            new Request('http://localhost/config', { headers: { origin: evilOrigin } }),
        );

        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('does not reflect an arbitrary origin on a preflight request', async () => {
        const res = await app.handle(
            new Request('http://localhost/config', {
                method: 'OPTIONS',
                headers: {
                    origin: evilOrigin,
                    'access-control-request-method': 'GET',
                },
            }),
        );

        expect(res.headers.get('access-control-allow-origin')).not.toBe(evilOrigin);
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });
});
