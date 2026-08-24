import { describe, expect, it } from 'bun:test';
import {
    checkCompatibility,
    DISCOVERY_VERSION,
    discoverInstance,
    type InstanceDocument,
    PROTOCOL_VERSION,
} from '../src/instance';

const doc = (overrides: Partial<InstanceDocument> = {}): InstanceDocument => ({
    bolter: DISCOVERY_VERSION,
    name: 'Test',
    api: 'https://api.test',
    protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION },
    features: ['multipart'],
    limits: {
        maxFileSize: 1,
        maxFilesPerArchive: 1,
        maxExpireSeconds: 1,
        maxDownloads: 1,
        multipartThreshold: 1,
        minPartSize: 1,
        maxParts: 1,
        maxMetadataBytes: 1,
    },
    defaults: { expireSeconds: 1, downloads: 1 },
    ...overrides,
});

/** Answers a fixed map of paths; everything else 404s. */
function routes(map: Record<string, unknown>) {
    const seen: string[] = [];
    const impl = (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        seen.push(path);
        const body = map[path];
        return Promise.resolve(
            body === undefined
                ? new Response('nope', { status: 404 })
                : new Response(JSON.stringify(body), { status: 200 }),
        );
    };
    return { impl, seen };
}

describe('checkCompatibility', () => {
    it('accepts a matching instance', () => {
        expect(checkCompatibility(doc())).toEqual({ ok: true, warnings: [] });
    });

    it('refuses an instance that requires a newer protocol', () => {
        const result = checkCompatibility(doc({ protocol: { version: 5, min: 5 } }), 1);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toMatch(/upgrade the client/);
    });

    it('warns but proceeds when the instance is older than the client', () => {
        const result = checkCompatibility(doc({ protocol: { version: 1, min: 1 } }), 2);
        expect(result.ok).toBe(true);
        expect(result.ok && result.warnings[0]).toMatch(/stay within the older set/);
    });

    it('warns but proceeds on a newer document version', () => {
        // Documents gain fields; refusing to read one because it grew would
        // make every deployed client a liability the moment the server ships.
        const result = checkCompatibility(doc({ bolter: DISCOVERY_VERSION + 1 }));
        expect(result.ok).toBe(true);
        expect(result.ok && result.warnings[0]).toMatch(/ignoring anything newer/);
    });
});

describe('discoverInstance', () => {
    it('reads /instance.json and fills in the origin it was served from', async () => {
        const { impl } = routes({ '/instance.json': doc() });
        const found = await discoverInstance('https://send.fm', { fetch: impl });
        expect(found.source).toBe('instance.json');
        expect(found.instance.web).toBe('https://send.fm');
        expect(found.instance.api).toBe('https://api.test');
    });

    it('does not overwrite a web origin the instance stated itself', async () => {
        const { impl } = routes({ '/instance.json': doc({ web: 'https://canonical.example' }) });
        const found = await discoverInstance('https://mirror.example', { fetch: impl });
        expect(found.instance.web).toBe('https://canonical.example');
    });

    it('falls back to /api/instance.json for the reverse-proxy layout', async () => {
        const { impl, seen } = routes({ '/api/instance.json': doc() });
        const found = await discoverInstance('https://self.hosted', { fetch: impl });
        expect(found.source).toBe('api/instance.json');
        expect(seen).toEqual(['/instance.json', '/api/instance.json']);
    });

    it('synthesizes a document from /config for instances predating discovery', async () => {
        const { impl } = routes({
            '/config': {
                LIMITS: {
                    MAX_FILE_SIZE: 500,
                    MAX_FILES_PER_ARCHIVE: 10,
                    MAX_EXPIRE_SECONDS: 60,
                    MAX_DOWNLOADS: 3,
                },
                DEFAULTS: { EXPIRE_SECONDS: 30, DOWNLOADS: 1 },
                UI: { TITLE: 'Old Instance' },
            },
        });
        const found = await discoverInstance('https://old.example', { fetch: impl });
        expect(found.source).toBe('legacy-config');
        expect(found.instance.name).toBe('Old Instance');
        expect(found.instance.limits.maxFileSize).toBe(500);
        // An instance answering /config on this origin is the API; whether it
        // also serves the web app is unknowable from here.
        expect(found.instance.api).toBe('https://old.example');
    });

    it('ignores a 200 that is not a discovery document', async () => {
        const { impl } = routes({ '/instance.json': { hello: 'world' } });
        await expect(discoverInstance('https://not.bolter', { fetch: impl })).rejects.toThrow(
            /No Bolter instance/,
        );
    });

    it('tolerates a trailing slash on the origin', async () => {
        const { impl, seen } = routes({ '/instance.json': doc() });
        await discoverInstance('https://send.fm/', { fetch: impl });
        expect(seen[0]).toBe('/instance.json');
    });

    it('reports a clear failure when nothing answers', async () => {
        const impl = () => Promise.reject(new Error('ECONNREFUSED'));
        await expect(discoverInstance('https://down.example', { fetch: impl })).rejects.toThrow(
            /No Bolter instance at https:\/\/down.example/,
        );
    });
});

/**
 * Regression: a discovery document must never be able to move a client from
 * TLS to cleartext.
 *
 * The bug that motivated this shipped as a 404, not as a security warning. A
 * backend behind a TLS-terminating proxy derived `api` from its own
 * `request.url` — plaintext on the internal hop — and advertised `http://`. The
 * CLI took it at face value, its `POST /upload/url` was answered by the edge
 * with a 301 to https, and the fetch spec turned that POST into a GET with no
 * body. The route only exists for POST, so the user saw `HTTP 404` on an
 * endpoint that was working perfectly.
 *
 * The scheme, unlike the host, is something the caller already knows for
 * certain: it is the one it just completed a request over. So it wins.
 */
describe('discoverInstance scheme downgrade', () => {
    it('refuses to be moved from https to http by the document', async () => {
        const { impl } = routes({ '/instance.json': doc({ api: 'http://api.send.fm' }) });
        const found = await discoverInstance('https://send.fm', { fetch: impl });
        expect(found.instance.api).toBe('https://api.send.fm');
    });

    it('upgrades a same-host api, which is the proxy-terminated-TLS case', async () => {
        const { impl } = routes({
            '/instance.json': doc({ api: 'http://backend.up.railway.app' }),
        });
        const found = await discoverInstance('https://backend.up.railway.app', { fetch: impl });
        expect(found.instance.api).toBe('https://backend.up.railway.app');
    });

    it('preserves the port and path while upgrading', async () => {
        const { impl } = routes({ '/instance.json': doc({ api: 'http://api.test:8080' }) });
        const found = await discoverInstance('https://web.test', { fetch: impl });
        expect(found.instance.api).toBe('https://api.test:8080');
    });

    it('leaves http alone when the client itself spoke http', async () => {
        // Local development and plaintext self-hosting are legitimate; the rule
        // is "never downgrade", not "always https".
        const { impl } = routes({ '/instance.json': doc({ api: 'http://localhost:3001' }) });
        const found = await discoverInstance('http://localhost:3000', { fetch: impl });
        expect(found.instance.api).toBe('http://localhost:3001');
    });

    it('leaves an already-https api untouched', async () => {
        const { impl } = routes({ '/instance.json': doc({ api: 'https://api.send.fm' }) });
        const found = await discoverInstance('https://send.fm', { fetch: impl });
        expect(found.instance.api).toBe('https://api.send.fm');
    });

    it('does not choke on an api value that is not a URL', async () => {
        const { impl } = routes({ '/instance.json': doc({ api: 'not a url' }) });
        const found = await discoverInstance('https://send.fm', { fetch: impl });
        expect(found.instance.api).toBe('not a url');
    });
});
