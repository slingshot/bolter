import { Elysia } from 'elysia';
import { config } from '../config';
import { plausibleLogger as logger } from '../logger';

const PLAUSIBLE_API = 'https://plausible.io';

/** Plausible events are tiny JSON blobs; anything larger is not a real event. */
export const MAX_EVENT_BODY_BYTES = 8 * 1024;

/** Upstream must never be able to park a backend request indefinitely. */
export const UPSTREAM_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// IP helpers (exported for tests)
// ---------------------------------------------------------------------------

function parseIpv4(ip: string): bigint | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
        return null;
    }
    let value = 0n;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) {
            return null;
        }
        const octet = Number(part);
        if (octet > 255) {
            return null;
        }
        value = (value << 8n) | BigInt(octet);
    }
    return value;
}

function parseIpv6(ip: string): bigint | null {
    let text = ip;
    const zone = text.indexOf('%');
    if (zone !== -1) {
        text = text.slice(0, zone);
    }
    if (!text.includes(':')) {
        return null;
    }

    // Normalise an embedded IPv4 suffix (e.g. ::ffff:127.0.0.1) into two groups.
    const lastColon = text.lastIndexOf(':');
    const suffix = text.slice(lastColon + 1);
    if (suffix.includes('.')) {
        const v4 = parseIpv4(suffix);
        if (v4 === null) {
            return null;
        }
        const hi = (v4 >> 16n) & 0xffffn;
        const lo = v4 & 0xffffn;
        text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
    }

    const halves = text.split('::');
    if (halves.length > 2) {
        return null;
    }

    const parseGroups = (part: string): string[] | null => {
        if (part === '') {
            return [];
        }
        const groups = part.split(':');
        for (const group of groups) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
                return null;
            }
        }
        return groups;
    };

    const head = parseGroups(halves[0] ?? '');
    const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
    if (head === null || tail === null) {
        return null;
    }

    const present = head.length + tail.length;
    if (halves.length === 2 ? present > 7 : present !== 8) {
        return null;
    }

    const groups = [...head, ...Array(8 - present).fill('0'), ...tail];
    let value = 0n;
    for (const group of groups) {
        value = (value << 16n) | BigInt(parseInt(group, 16));
    }
    return value;
}

/** Parse an IPv4 or IPv6 literal. IPv4-mapped IPv6 collapses to IPv4. */
export function parseIp(ip: string): { value: bigint; bits: 32 | 128 } | null {
    const text = ip.trim();
    if (text === '') {
        return null;
    }
    if (text.includes(':')) {
        const value = parseIpv6(text);
        if (value === null) {
            return null;
        }
        // ::ffff:0:0/96 — IPv4-mapped, compare as IPv4.
        if (value >> 32n === 0xffffn) {
            return { value: value & 0xffffffffn, bits: 32 };
        }
        return { value, bits: 128 };
    }
    const v4 = parseIpv4(text);
    return v4 === null ? null : { value: v4, bits: 32 };
}

/** True when `ip` falls inside `cidr` (a bare address means a /32 or /128). */
export function isIpInCidr(ip: string, cidr: string): boolean {
    const slash = cidr.indexOf('/');
    const network = parseIp(slash === -1 ? cidr : cidr.slice(0, slash));
    const address = parseIp(ip);
    if (!network || !address || network.bits !== address.bits) {
        return false;
    }

    const prefix = slash === -1 ? network.bits : Number(cidr.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > network.bits) {
        return false;
    }

    const shift = BigInt(network.bits - prefix);
    return address.value >> shift === network.value >> shift;
}

function isTrustedPeer(peerIp: string | null | undefined, cidrs: string[]): boolean {
    if (!peerIp) {
        return false;
    }
    return cidrs.some((cidr) => isIpInCidr(peerIp, cidr));
}

/**
 * Decide which IP is forwarded to Plausible as the visitor.
 *
 * `cf-connecting-ip` is preferred deliberately: behind Cloudflare → Railway the
 * `x-forwarded-for` chain is rewritten by Railway's edge and its leftmost entry
 * is a datacenter IP that Plausible silently bot-filters (202 +
 * `x-plausible-dropped`). That preference is kept — it is only *narrowed*: the
 * header must be a syntactically valid IP, and when `TRUSTED_EDGE_CIDRS` is
 * configured the request's peer must actually be one of those edge addresses,
 * so a client hitting the backend directly cannot forge attribution.
 */
export function resolveClientIp(options: {
    cfConnectingIp?: string | null;
    xForwardedFor?: string | null;
    peerIp?: string | null;
    trustedEdgeCidrs: string[];
}): string {
    const cf = options.cfConnectingIp?.trim();
    const xff = options.xForwardedFor?.trim() ?? '';

    if (cf && parseIp(cf) !== null) {
        const peerChecked = options.trustedEdgeCidrs.length > 0;
        if (!peerChecked || isTrustedPeer(options.peerIp, options.trustedEdgeCidrs)) {
            return cf;
        }
    }

    return xff;
}

// ---------------------------------------------------------------------------
// Event validation
// ---------------------------------------------------------------------------

/**
 * Plausible accepts a single domain or a comma-separated list in `d`. Every
 * entry must belong to this deployment, otherwise the proxy is an open relay
 * that launders fake traffic onto third-party sites from the operator's IP.
 */
export function isEventDomainAllowed(domain: unknown, allowed: string[]): boolean {
    if (typeof domain !== 'string') {
        return false;
    }
    const entries = domain
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d !== '');
    if (entries.length === 0) {
        return false;
    }
    return entries.every((d) => allowed.includes(d));
}

async function readBody(request: Request, parsed: unknown): Promise<string> {
    if (typeof parsed === 'string') {
        return parsed;
    }
    if (parsed && typeof parsed === 'object') {
        return JSON.stringify(parsed);
    }
    return await request.text();
}

export const plausibleRoutes = new Elysia({ prefix: '/pl' }).post(
    '/api/event',
    async ({ request, body, set, server }) => {
        const declaredLength = Number(request.headers.get('content-length') ?? '');
        if (Number.isFinite(declaredLength) && declaredLength > MAX_EVENT_BODY_BYTES) {
            set.status = 413;
            return { error: 'Event payload too large' };
        }

        const raw = await readBody(request, body);
        if (Buffer.byteLength(raw, 'utf8') > MAX_EVENT_BODY_BYTES) {
            set.status = 413;
            return { error: 'Event payload too large' };
        }

        let event: { d?: unknown };
        try {
            event = JSON.parse(raw) as { d?: unknown };
        } catch {
            set.status = 400;
            return { error: 'Invalid event payload' };
        }

        if (!isEventDomainAllowed(event?.d, config.plausibleDomains)) {
            logger.warn({ domain: event?.d }, 'Rejected Plausible event for a foreign domain');
            set.status = 403;
            return { error: 'Event domain not allowed' };
        }

        const clientIp = resolveClientIp({
            cfConnectingIp: request.headers.get('cf-connecting-ip'),
            xForwardedFor: request.headers.get('x-forwarded-for'),
            peerIp: server?.requestIP(request)?.address ?? null,
            trustedEdgeCidrs: config.trustedEdgeCidrs,
        });

        let response: Response;
        try {
            response = await fetch(`${PLAUSIBLE_API}/api/event`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': request.headers.get('user-agent') || '',
                    'X-Forwarded-For': clientIp,
                },
                body: raw,
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });
        } catch (e) {
            logger.warn(
                { error: e instanceof Error ? e.message : String(e) },
                'Plausible upstream request failed',
            );
            set.status = 502;
            return { error: 'Analytics upstream unavailable' };
        }

        // Plausible returns 202 even for events it discards; the only signal is
        // this header. Log it and pass it through so drops are observable both
        // server-side and from browser devtools.
        const dropped = response.headers.get('x-plausible-dropped');
        if (dropped) {
            logger.warn({ clientIp }, 'Plausible dropped event (bot-filtered upstream)');
        }

        return new Response(response.body, {
            status: response.status,
            headers: dropped ? { 'x-plausible-dropped': dropped } : undefined,
        });
    },
    {
        detail: { hide: true },
    },
);
