import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- Mock storage before importing the app (mirrors health.test.ts) ---

const mockRedis = {
    ping: mock(() => Promise.resolve(true)),
};

const mockStorage = {
    redis: mockRedis,
    ping: mock(() => Promise.resolve({ redis: true, s3: true })),
};

mock.module('../storage', () => ({
    storage: mockStorage,
}));

mock.module('../storage/redis', () => ({
    redis: mockRedis,
    RedisStorage: class {},
}));

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

import { app } from '../app';
import { getHealthTiming } from '../lib/health';

// src/__tests__ → src → apps/backend → apps → <repo root>
const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

function read(relativePath: string): string {
    return readFileSync(join(repoRoot, relativePath), 'utf8');
}

const backendDockerfile = read('apps/backend/Dockerfile');
const composeFile = read('docker-compose.yml');
const nginxConf = read('apps/frontend/nginx.conf');
const frontendDockerfile = read('apps/frontend/Dockerfile');
const appSource = read('apps/backend/src/app.ts');

/** Every `http://localhost:3001/...` URL referenced by a container healthcheck. */
function healthcheckPaths(source: string): string[] {
    const matches = source.matchAll(/http:\/\/localhost:3001(\/[^'")\s]*)/g);
    return [...matches].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
// Finding #10 — the Dockerfile and compose healthchecks probed `/api/health/*`
// while the app mounts `/health/*`, so the stack could never become healthy.
// ---------------------------------------------------------------------------

describe('container healthcheck paths (finding #10)', () => {
    it('the backend Dockerfile probes a path the app actually serves', async () => {
        const paths = healthcheckPaths(backendDockerfile);

        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
            const res = await app.handle(new Request(`http://localhost${path}`));
            expect({ path, status: res.status }).toEqual({ path, status: 200 });
        }
    });

    it('the compose backend healthcheck probes a path the app actually serves', async () => {
        const paths = healthcheckPaths(composeFile);

        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
            const res = await app.handle(new Request(`http://localhost${path}`));
            expect({ path, status: res.status }).toEqual({ path, status: 200 });
        }
    });

    it('no deployment healthcheck uses the non-existent /api prefix', () => {
        expect(backendDockerfile).not.toContain('localhost:3001/api/');
        expect(composeFile).not.toContain('localhost:3001/api/');
    });

    it('confirms the previously probed /api paths really are 404s', async () => {
        for (const path of ['/api/health/live', '/api/health/ready']) {
            const res = await app.handle(new Request(`http://localhost${path}`));
            expect(res.status).toBe(404);
        }
    });
});

describe('nginx /api proxying (finding #10)', () => {
    it('strips the /api prefix so backend root-mounted routes resolve', () => {
        // A trailing slash on proxy_pass is what makes nginx replace the matched
        // location prefix; without it `/api/health/live` reaches the backend
        // verbatim and 404s.
        expect(nginxConf).toMatch(
            /location\s+\/api\/?\s*\{[^}]*proxy_pass\s+http:\/\/backend:3001\/;/,
        );
    });
});

// ---------------------------------------------------------------------------
// Finding #6 — the shipped deployment must set NODE_ENV explicitly so CORS is
// never left to an unset variable.
// ---------------------------------------------------------------------------

describe('deployment environment (finding #6)', () => {
    it('the backend Dockerfile pins NODE_ENV=production', () => {
        expect(backendDockerfile).toMatch(/ENV\s+NODE_ENV=production/);
    });

    it('docker-compose passes NODE_ENV to the backend, defaulting to production', () => {
        expect(composeFile).toMatch(/NODE_ENV=\$\{NODE_ENV:-production\}/);
    });

    it('docker-compose allows the frontend origin explicitly now that CORS is closed', () => {
        expect(composeFile).toContain('CORS_ORIGINS=');
    });
});

// ---------------------------------------------------------------------------
// Finding #29 — caching health probes is pointless if the TTL is shorter than
// the interval the shipped deployment actually polls at.
// ---------------------------------------------------------------------------

describe('health probe cache vs shipped probe interval (finding #29)', () => {
    /** Interval of the compose healthcheck that hits `/health/ready`. */
    function readyProbeIntervalSeconds(): number {
        const block = composeFile
            .split('healthcheck:')
            .find((section) => section.includes('localhost:3001/health/ready'));
        expect(block).toBeDefined();
        const match = /interval:\s*(\d+)s/.exec(block as string);
        expect(match).not.toBeNull();
        return Number((match as RegExpExecArray)[1]);
    }

    it('caches for at least as long as the compose healthcheck interval', () => {
        const intervalMs = readyProbeIntervalSeconds() * 1000;

        expect(intervalMs).toBeGreaterThan(0);
        // Pre-fix the TTL was a hardcoded 5s against a 30s interval, so every
        // scheduled probe missed the cache and re-ran the provider fan-out.
        expect(getHealthTiming().cacheTtlMs).toBeGreaterThanOrEqual(intervalMs);
    });
});

// ---------------------------------------------------------------------------
// Instance discovery is served from the web origin as a static file, so it is
// subject to the frontend's caching rules and its build arguments — both of
// which are easy to get wrong in a way nothing else notices.
// ---------------------------------------------------------------------------

describe('instance.json serving', () => {
    it('is matched before the immutable static-asset rule', () => {
        const exact = nginxConf.indexOf('location = /instance.json');
        const assets = nginxConf.indexOf('location ~*');
        expect(exact).toBeGreaterThan(-1);
        // nginx prefers an exact `=` match regardless of order, but keeping the
        // declaration first is what makes the intent legible to the next
        // person editing the asset regex.
        expect(exact).toBeLessThan(assets);
    });

    it('is not served immutable', () => {
        // The asset rule sets `expires 1y; Cache-Control: immutable`. Applied
        // to this document it would pin a stale API URL and stale limits on
        // every client that ever fetched it, with no way to correct them.
        const block = nginxConf.slice(
            nginxConf.indexOf('location = /instance.json'),
            nginxConf.indexOf('location ~*'),
        );
        expect(block).toContain('max-age=300');
        expect(block).not.toContain('immutable');
    });

    it('derives its api origin through requestOrigin, not request.url', () => {
        // Every platform this deploys to terminates TLS at the edge, so the
        // request reaching this process is plaintext and `request.url` reports
        // `http://`. That value becomes the client's base URL, so advertising
        // it sends every later call through the edge's 301 — and the fetch spec
        // rewrites a redirected POST into a bodyless GET, which surfaces as a
        // 404 on `/upload/url`, a route that works perfectly.
        const route = appSource.slice(
            appSource.indexOf("'/instance.json'"),
            appSource.indexOf('cli: {'),
        );
        expect(route).toContain('requestOrigin(request)');
        expect(route).not.toContain('new URL(request.url).origin');
    });

    it('has the API URL available at frontend build time', () => {
        // The document is generated during `vite build`, so without this ARG
        // every containerised deployment advertises localhost as its API.
        expect(frontendDockerfile).toContain('ARG VITE_API_URL');
    });

    it('is passed that URL by compose', () => {
        expect(composeFile).toContain('VITE_API_URL=');
    });
});
