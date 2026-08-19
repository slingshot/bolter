import { describe, expect, it } from 'bun:test';
import { type Authenticator, createBolterClient, type FetchLike } from '../src/client';

/** Records every request so a test can assert on what was actually signed. */
function recordingFetch(
    responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
) {
    const calls: Array<{ url: string; init?: RequestInit; authorization?: string }> = [];
    let i = 0;
    const impl = ((url: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(url), init, authorization: headers.Authorization });
        const spec = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return Promise.resolve(
            new Response(spec.body === undefined ? null : JSON.stringify(spec.body), {
                status: spec.status,
                headers: spec.headers,
            }),
        );
    }) as unknown as FetchLike;
    return { impl, calls };
}

function stubAuth(startingNonce = 'nonce-1'): Authenticator {
    return {
        nonce: startingNonce,
        // Signing is HMAC(authKey, nonce) in reality; echoing the nonce is
        // enough to prove the retry re-signed with the *new* challenge.
        authHeader() {
            return Promise.resolve(`send-v1 sig-for-${this.nonce}`);
        },
    };
}

describe('send-v1 challenge-retry', () => {
    it('re-signs with the challenged nonce and retries once', async () => {
        const { impl, calls } = recordingFetch([
            {
                status: 401,
                body: { error: 'x' },
                headers: { 'WWW-Authenticate': 'send-v1 nonce-2' },
            },
            {
                status: 200,
                body: { metadata: 'abc', ttl: 100, encrypted: true },
                headers: { 'WWW-Authenticate': 'send-v1 nonce-3' },
            },
        ]);
        const auth = stubAuth();
        const client = createBolterClient({ baseUrl: 'https://api.example', fetch: impl });

        const result = await client.getRawMetadata('abc123', auth);

        expect(calls).toHaveLength(2);
        expect(calls[0].authorization).toBe('send-v1 sig-for-nonce-1');
        expect(calls[1].authorization).toBe('send-v1 sig-for-nonce-2');
        expect(result.ttl).toBe(100);
    });

    it('harvests the rotated nonce so the next request is not stale', async () => {
        const { impl } = recordingFetch([
            {
                status: 200,
                body: { metadata: 'abc', ttl: 1, encrypted: true },
                headers: { 'WWW-Authenticate': 'send-v1 rotated' },
            },
        ]);
        const auth = stubAuth();
        const client = createBolterClient({ baseUrl: 'https://api.example', fetch: impl });

        await client.getRawMetadata('abc123', auth);

        expect(auth.nonce).toBe('rotated');
    });

    it('does not retry a 401 that carries no challenge', async () => {
        const { impl, calls } = recordingFetch([{ status: 401, body: { error: 'x' } }]);
        const client = createBolterClient({ baseUrl: 'https://api.example', fetch: impl });

        await expect(client.getRawMetadata('abc123', stubAuth())).rejects.toThrow('HTTP 401');
        expect(calls).toHaveLength(1);
    });

    it('sends no Authorization header for an unencrypted share', async () => {
        const { impl, calls } = recordingFetch([
            { status: 200, body: { metadata: 'abc', ttl: 1, encrypted: false } },
        ]);
        const client = createBolterClient({ baseUrl: 'https://api.example', fetch: impl });

        await client.getRawMetadata('abc123', null);

        expect(calls[0].authorization).toBeUndefined();
    });
});

describe('download status', () => {
    it('reports gone for 404 and 410, not error', async () => {
        for (const status of [404, 410]) {
            const { impl } = recordingFetch([{ status, body: { error: 'x' } }]);
            const client = createBolterClient({ baseUrl: 'https://api.example', fetch: impl });
            expect(await client.getDownloadStatus('id', null)).toEqual({ status: 'gone' });
        }
    });

    it('reports error — never gone — when the network fails', async () => {
        const impl = (() => Promise.reject(new Error('offline'))) as unknown as FetchLike;
        const client = createBolterClient({ baseUrl: 'https://api.example', fetch: impl });
        // Rendering a transient failure as "limit reached" tells the user
        // their file is destroyed when it is not.
        expect(await client.getDownloadStatus('id', null)).toEqual({ status: 'error' });
    });

    it('returns counts at the limit, where the route answers 200 with no URL', async () => {
        const { impl } = recordingFetch([
            { status: 200, body: { useSignedUrl: false, dl: 3, dlimit: 3 } },
        ]);
        const client = createBolterClient({ baseUrl: 'https://api.example', fetch: impl });
        expect(await client.getDownloadStatus('id', null)).toEqual({
            status: 'ok',
            dl: 3,
            dlimit: 3,
            url: undefined,
        });
    });
});

describe('reportDownloadComplete', () => {
    it('retries a 401 but never a network failure', async () => {
        const { impl, calls } = recordingFetch([
            { status: 401, headers: { 'WWW-Authenticate': 'send-v1 n2' } },
            { status: 200, body: { deleted: false, dl: 1, dlimit: 3 } },
        ]);
        const client = createBolterClient({ baseUrl: 'https://api.example', fetch: impl });
        expect(await client.reportDownloadComplete('id', stubAuth())).toBe(true);
        expect(calls).toHaveLength(2);

        // The increment is not idempotent, so a lost response may already have
        // counted; retrying it would burn a second download.
        let attempts = 0;
        const failing = (() => {
            attempts += 1;
            return Promise.reject(new Error('offline'));
        }) as unknown as FetchLike;
        const offline = createBolterClient({ baseUrl: 'https://api.example', fetch: failing });
        expect(await offline.reportDownloadComplete('id', null)).toBe(false);
        expect(attempts).toBe(1);
    });
});

describe('fetch resolution', () => {
    it('uses a global fetch installed after the client was created', async () => {
        const client = createBolterClient({ baseUrl: 'https://api.example' });
        const original = globalThis.fetch;
        let sawUrl = '';
        try {
            // Capturing globalThis.fetch at construction would bypass every
            // wrapper a host installs later — instrumentation, a proxy, or the
            // frontend's own test doubles, which is how this was caught.
            globalThis.fetch = ((url: string | URL | Request) => {
                sawUrl = String(url);
                return Promise.resolve(
                    new Response(JSON.stringify({ exists: true }), { status: 200 }),
                );
            }) as unknown as typeof globalThis.fetch;

            expect(await client.exists('abc')).toBe(true);
            expect(sawUrl).toBe('https://api.example/exists/abc');
        } finally {
            globalThis.fetch = original;
        }
    });
});

describe('base URL handling', () => {
    it('tolerates a trailing slash', async () => {
        const { impl, calls } = recordingFetch([{ status: 200, body: { exists: true } }]);
        const client = createBolterClient({ baseUrl: 'https://api.example/', fetch: impl });
        await client.exists('abc');
        expect(calls[0].url).toBe('https://api.example/exists/abc');
    });
});
