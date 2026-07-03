import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — must be registered BEFORE any module that transitively imports them
// ---------------------------------------------------------------------------

const warnSpy = mock((_obj: unknown, _msg?: string) => {
    /* noop */
});
const noopLogger = {
    info: () => {
        /* noop */
    },
    warn: warnSpy,
    error: () => {
        /* noop */
    },
    debug: () => {
        /* noop */
    },
    child: () => noopLogger,
};
mock.module('../../logger', () => ({
    logger: noopLogger,
    uploadLogger: noopLogger,
    downloadLogger: noopLogger,
    storageLogger: noopLogger,
    s3Logger: noopLogger,
    plausibleLogger: noopLogger,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { Elysia } from 'elysia';
import { plausibleRoutes } from '../../routes/plausible';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
    return new Elysia().use(plausibleRoutes);
}

function eventPost(headers: Record<string, string>) {
    return new Request('http://localhost/pl/api/event', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...headers },
        body: JSON.stringify({ n: 'pageview', d: 'send.fm', u: 'https://send.fm/' }),
    });
}

type FetchArgs = [string | URL | Request, RequestInit | undefined];

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock<(...args: FetchArgs) => Promise<Response>>>;
let upstreamResponse: () => Response;

beforeEach(() => {
    warnSpy.mockClear();
    upstreamResponse = () => new Response('ok', { status: 202 });
    fetchMock = mock((..._args: FetchArgs) => Promise.resolve(upstreamResponse()));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function forwardedHeaders(): Record<string, string> {
    const init = fetchMock.mock.calls[0]?.[1];
    return (init?.headers ?? {}) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /pl/api/event', () => {
    it('proxies to plausible.io and returns the upstream status', async () => {
        const res = await createApp().handle(eventPost({}));

        expect(res.status).toBe(202);
        expect(await res.text()).toBe('ok');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://plausible.io/api/event');
    });

    it('prefers cf-connecting-ip over x-forwarded-for for visitor attribution', async () => {
        // Behind Cloudflare → Railway, x-forwarded-for can be rewritten so its
        // leftmost entry is a datacenter IP, which Plausible silently drops.
        // cf-connecting-ip always carries the real visitor IP.
        await createApp().handle(
            eventPost({
                'cf-connecting-ip': '203.0.113.7',
                'x-forwarded-for': '172.71.147.20',
            }),
        );

        expect(forwardedHeaders()['X-Forwarded-For']).toBe('203.0.113.7');
    });

    it('falls back to x-forwarded-for when cf-connecting-ip is absent', async () => {
        await createApp().handle(eventPost({ 'x-forwarded-for': '203.0.113.9, 172.71.147.20' }));

        expect(forwardedHeaders()['X-Forwarded-For']).toBe('203.0.113.9, 172.71.147.20');
    });

    it('forwards the client user-agent', async () => {
        await createApp().handle(eventPost({ 'user-agent': 'TestBrowser/1.0' }));

        expect(forwardedHeaders()['User-Agent']).toBe('TestBrowser/1.0');
    });

    it('propagates the x-plausible-dropped marker and logs a warning', async () => {
        upstreamResponse = () =>
            new Response('ok', { status: 202, headers: { 'x-plausible-dropped': '1' } });

        const res = await createApp().handle(eventPost({ 'cf-connecting-ip': '203.0.113.7' }));

        expect(res.status).toBe(202);
        expect(res.headers.get('x-plausible-dropped')).toBe('1');
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not set the drop marker or warn when the event is accepted', async () => {
        const res = await createApp().handle(eventPost({ 'cf-connecting-ip': '203.0.113.7' }));

        expect(res.headers.get('x-plausible-dropped')).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
    });
});
