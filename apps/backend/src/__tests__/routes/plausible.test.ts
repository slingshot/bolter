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
import {
    isEventDomainAllowed,
    isIpInCidr,
    MAX_EVENT_BODY_BYTES,
    parseIp,
    plausibleRoutes,
    resolveClientIp,
    UPSTREAM_TIMEOUT_MS,
} from '../../routes/plausible';

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

// ---------------------------------------------------------------------------
// Finding #28 — the proxy must not act as an open relay: foreign event domains
// are rejected, the body is capped, and the upstream call is time-bounded.
// ---------------------------------------------------------------------------

function eventPostWithBody(body: string, headers: Record<string, string> = {}) {
    return new Request('http://localhost/pl/api/event', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...headers },
        body,
    });
}

describe('POST /pl/api/event — domain allowlist (finding #28)', () => {
    it('rejects an event attributed to a foreign domain without contacting upstream', async () => {
        const res = await createApp().handle(
            eventPostWithBody(
                JSON.stringify({ n: 'pageview', d: 'victim-competitor.com', u: 'https://x/' }),
            ),
        );

        expect(res.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an event with no domain at all', async () => {
        const res = await createApp().handle(
            eventPostWithBody(JSON.stringify({ n: 'pageview', u: 'https://x/' })),
        );

        expect(res.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a domain list that smuggles a foreign domain alongside a valid one', async () => {
        const res = await createApp().handle(
            eventPostWithBody(
                JSON.stringify({ n: 'pageview', d: 'send.fm,victim-competitor.com' }),
            ),
        );

        expect(res.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a body that is not valid JSON', async () => {
        const res = await createApp().handle(eventPostWithBody('not json at all'));

        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still forwards events for this deployment', async () => {
        const res = await createApp().handle(eventPost({}));

        expect(res.status).toBe(202);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('isEventDomainAllowed (finding #28)', () => {
    it('accepts an exact match, case-insensitively', () => {
        expect(isEventDomainAllowed('send.fm', ['send.fm'])).toBe(true);
        expect(isEventDomainAllowed(' SEND.FM ', ['send.fm'])).toBe(true);
    });

    it('accepts a comma separated list where every entry is allowed', () => {
        expect(isEventDomainAllowed('send.fm, other.example', ['send.fm', 'other.example'])).toBe(
            true,
        );
    });

    it('rejects unknown, empty and non-string domains', () => {
        expect(isEventDomainAllowed('evil.example', ['send.fm'])).toBe(false);
        expect(isEventDomainAllowed('', ['send.fm'])).toBe(false);
        expect(isEventDomainAllowed(undefined, ['send.fm'])).toBe(false);
        expect(isEventDomainAllowed(42, ['send.fm'])).toBe(false);
    });

    it('rejects a subdomain of an allowed domain (no suffix matching)', () => {
        expect(isEventDomainAllowed('evil.send.fm', ['send.fm'])).toBe(false);
    });
});

describe('POST /pl/api/event — body cap (finding #28)', () => {
    it('rejects an oversized payload without contacting upstream', async () => {
        const padding = 'x'.repeat(MAX_EVENT_BODY_BYTES + 1);
        const res = await createApp().handle(
            eventPostWithBody(JSON.stringify({ n: 'pageview', d: 'send.fm', p: padding })),
        );

        expect(res.status).toBe(413);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts a payload just under the cap', async () => {
        const body = JSON.stringify({ n: 'pageview', d: 'send.fm', p: 'x'.repeat(64) });
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(MAX_EVENT_BODY_BYTES);

        const res = await createApp().handle(eventPostWithBody(body));

        expect(res.status).toBe(202);
    });
});

describe('POST /pl/api/event — upstream timeout (finding #28)', () => {
    it('passes an abort signal to the upstream fetch', async () => {
        await createApp().handle(eventPost({}));

        const init = fetchMock.mock.calls[0]?.[1];
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(UPSTREAM_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    });

    it('returns 502 instead of throwing when the upstream call fails or times out', async () => {
        fetchMock.mockImplementation(() =>
            Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
        );

        const res = await createApp().handle(eventPost({}));

        expect(res.status).toBe(502);
    });
});

// ---------------------------------------------------------------------------
// Finding #28 — cf-connecting-ip stays preferred (deliberate prior hardening)
// but is validated, and can be gated on the peer being a known edge address.
// ---------------------------------------------------------------------------

describe('resolveClientIp (finding #28)', () => {
    it('prefers cf-connecting-ip when no trusted edge ranges are configured', () => {
        expect(
            resolveClientIp({
                cfConnectingIp: '203.0.113.7',
                xForwardedFor: '172.71.147.20',
                peerIp: '10.0.0.5',
                trustedEdgeCidrs: [],
            }),
        ).toBe('203.0.113.7');
    });

    it('falls back to x-forwarded-for when cf-connecting-ip is not a valid IP', () => {
        expect(
            resolveClientIp({
                cfConnectingIp: 'not-an-ip',
                xForwardedFor: '203.0.113.9',
                trustedEdgeCidrs: [],
            }),
        ).toBe('203.0.113.9');
    });

    it('ignores a forged cf-connecting-ip when the peer is outside the trusted edge', () => {
        expect(
            resolveClientIp({
                cfConnectingIp: '1.2.3.4',
                xForwardedFor: '198.51.100.10',
                peerIp: '198.51.100.10',
                trustedEdgeCidrs: ['173.245.48.0/20'],
            }),
        ).toBe('198.51.100.10');
    });

    it('honours cf-connecting-ip when the peer is inside the trusted edge', () => {
        expect(
            resolveClientIp({
                cfConnectingIp: '1.2.3.4',
                xForwardedFor: '173.245.48.9',
                peerIp: '173.245.48.9',
                trustedEdgeCidrs: ['173.245.48.0/20'],
            }),
        ).toBe('1.2.3.4');
    });

    it('ignores cf-connecting-ip when the peer address is unknown and edges are configured', () => {
        expect(
            resolveClientIp({
                cfConnectingIp: '1.2.3.4',
                xForwardedFor: '',
                peerIp: null,
                trustedEdgeCidrs: ['173.245.48.0/20'],
            }),
        ).toBe('');
    });
});

describe('isIpInCidr (finding #28)', () => {
    it('matches IPv4 ranges', () => {
        expect(isIpInCidr('173.245.48.1', '173.245.48.0/20')).toBe(true);
        expect(isIpInCidr('173.245.63.255', '173.245.48.0/20')).toBe(true);
        expect(isIpInCidr('173.245.64.0', '173.245.48.0/20')).toBe(false);
        expect(isIpInCidr('10.0.0.1', '10.0.0.1')).toBe(true);
    });

    it('matches IPv6 ranges', () => {
        expect(isIpInCidr('2400:cb00::1', '2400:cb00::/32')).toBe(true);
        expect(isIpInCidr('2400:cb01::1', '2400:cb00::/32')).toBe(false);
    });

    it('treats an IPv4-mapped IPv6 peer as IPv4', () => {
        expect(isIpInCidr('::ffff:173.245.48.1', '173.245.48.0/20')).toBe(true);
    });

    it('rejects malformed input rather than matching', () => {
        expect(isIpInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
        expect(isIpInCidr('10.0.0.1', 'garbage/8')).toBe(false);
        expect(isIpInCidr('10.0.0.1', '10.0.0.0/99')).toBe(false);
        expect(isIpInCidr('999.1.1.1', '0.0.0.0/0')).toBe(false);
    });

    it('does not cross address families', () => {
        expect(isIpInCidr('2400:cb00::1', '0.0.0.0/0')).toBe(false);
        expect(isIpInCidr('1.2.3.4', '::/0')).toBe(false);
    });
});

describe('parseIp (finding #28)', () => {
    it('parses IPv4 and IPv6 literals', () => {
        expect(parseIp('127.0.0.1')?.bits).toBe(32);
        expect(parseIp('::1')?.bits).toBe(128);
        expect(parseIp('2001:db8::ff00:42:8329')?.bits).toBe(128);
    });

    it('rejects malformed literals', () => {
        expect(parseIp('')).toBeNull();
        expect(parseIp('256.1.1.1')).toBeNull();
        expect(parseIp('1.2.3')).toBeNull();
        expect(parseIp('1.2.3.4.5')).toBeNull();
        expect(parseIp('gggg::1')).toBeNull();
        expect(parseIp('1::2::3')).toBeNull();
    });
});
