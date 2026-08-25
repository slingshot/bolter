import { describe, expect, it, mock } from 'bun:test';

/**
 * Lives in __isolated_tests__, which package.json runs as its own `bun test`
 * process, because these mocks are process-global: `mock.module('../storage')`
 * replaces the module for every test file loaded afterwards, and Bun loads
 * files in directory order. Adding this file to __tests__ silently broke nine
 * unrelated storage and provider-registry tests that expect the real modules.
 *
 * Stub storage before importing the app so no route opens a real Redis or S3
 * connection.
 */
const mockRedis = { ping: mock(() => Promise.resolve(true)) };
mock.module('../storage', () => ({
    storage: { redis: mockRedis, ping: mock(() => Promise.resolve({ redis: true, s3: true })) },
}));
mock.module('../storage/redis', () => ({ redis: mockRedis, RedisStorage: class {} }));
mock.module('../storage/s3', () => ({
    s3Storage: { ping: mock(() => Promise.resolve(true)) },
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
mock.module('../storage/provider-registry', () => ({
    providerRegistry: {
        getActiveProviderId: mock(() => 'default'),
        healthCheckProvider: mock(() => Promise.resolve({ healthy: true, latencyMs: 1 })),
        healthCheckAll: mock(() => Promise.resolve({ default: true })),
    },
    ProviderRegistry: class {},
}));

import { checkCompatibility, DISCOVERY_VERSION } from '@bolter/protocol/instance';
import { UPLOAD_LIMITS } from '@bolter/shared';
import { app } from '../app';
import { config } from '../config';

async function getInstance(origin = 'https://api.send.fm') {
    const res = await app.handle(new Request(`${origin}/instance.json`));
    expect(res.status).toBe(200);
    return { res, doc: await res.json() };
}

describe('GET /instance.json', () => {
    it('is a document this client considers compatible', async () => {
        const { doc } = await getInstance();
        expect(doc.bolter).toBe(DISCOVERY_VERSION);
        expect(checkCompatibility(doc)).toEqual({ ok: true, warnings: [] });
    });

    it('names its own origin as the API, not the share-link origin', async () => {
        // These differ in production: share links point at the web app while
        // the API is a separate deployment. A client reaching this route has
        // by definition reached the API.
        const { doc } = await getInstance('https://api.send.fm');
        expect(doc.api).toBe('https://api.send.fm');
        expect(doc.web).toBe(config.baseUrl);
    });

    it('reports runtime limits, not build-time constants', async () => {
        const { doc } = await getInstance();
        expect(doc.limits.maxFileSize).toBe(config.maxFileSize);
        expect(doc.limits.maxDownloads).toBe(config.maxDownloads);
        expect(doc.defaults.expireSeconds).toBe(config.defaultExpireSeconds);
        // These are protocol constants rather than deployment settings.
        expect(doc.limits.minPartSize).toBe(UPLOAD_LIMITS.MIN_PART_SIZE);
        expect(doc.limits.maxParts).toBe(UPLOAD_LIMITS.MAX_PARTS);
    });

    it('is cacheable but not immutable', async () => {
        // An instance that moves its API must be able to say so; a long or
        // immutable cache would strand every client that fetched the old one.
        const { res } = await getInstance();
        expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    });

    it('advertises the features the API actually implements', async () => {
        const { doc } = await getInstance();
        expect(doc.features).toContain('multipart');
        expect(doc.features).toContain('resume');
        expect(doc.features).toContain('owner-tokens');
    });
});
