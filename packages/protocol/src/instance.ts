/**
 * Instance discovery.
 *
 * A share link points at the *web* origin (`https://send.fm/download/<id>#key`)
 * but the API usually lives somewhere else — send.fm's frontend is static
 * hosting and its backend is a separate deployment. A browser never notices,
 * because its API URL is baked in at build time. Any other client is handed
 * only the link, and nothing in the protocol previously let it get from one to
 * the other.
 *
 * `/instance.json` closes that gap, and carries enough for a client to decide
 * whether it can talk to this instance at all before it starts a transfer.
 */

/** Bumped only when the document's own shape changes incompatibly. */
export const DISCOVERY_VERSION = 1;

/**
 * Bumped when the wire protocol changes in a way older clients cannot handle.
 * Distinct from the document version: the document can gain fields without the
 * protocol changing, and usually will.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Capability names an instance may advertise. Clients should treat unknown
 * entries as opaque and absent entries as "not supported" — never as "old
 * server, assume yes".
 */
export type InstanceFeature =
    | 'multipart'
    | 'resume'
    | 'ece-v1'
    | 'owner-tokens'
    | 'password'
    | 'zip-at-upload';

export interface InstanceDocument {
    /** Discovery document version — `DISCOVERY_VERSION` at time of writing. */
    bolter: number;
    name: string;
    description?: string;
    /**
     * Origin serving the web app; where share links point. Optional because a
     * statically-built document cannot know its own deployed origin — a client
     * that fetched the document from that origin already does, and discovery
     * fills it in.
     */
    web?: string;
    /** Base URL of the HTTP API. May equal `web` on a single-origin deployment. */
    api: string;
    protocol: {
        /** Highest protocol version this instance speaks. */
        version: number;
        /** Lowest it still accepts. */
        min: number;
    };
    features: InstanceFeature[];
    limits: {
        maxFileSize: number;
        maxFilesPerArchive: number;
        maxExpireSeconds: number;
        maxDownloads: number;
        multipartThreshold: number;
        minPartSize: number;
        maxParts: number;
        maxMetadataBytes: number;
    };
    defaults: {
        expireSeconds: number;
        downloads: number;
    };
    cli?: {
        package?: string;
        /** Oldest CLI version this instance expects to work. Advisory. */
        minVersion?: string;
        install?: string;
    };
}

export type Compatibility = { ok: true; warnings: string[] } | { ok: false; reason: string };

/**
 * Decide whether a client speaking `PROTOCOL_VERSION` can use this instance.
 *
 * An unknown *document* version is not fatal — documents gain fields, and
 * refusing to read one because it grew would make every client a liability the
 * moment the server ships. A non-overlapping *protocol* range is fatal, because
 * proceeding means producing objects the server will reject or, worse, store
 * incorrectly.
 */
export function checkCompatibility(
    doc: InstanceDocument,
    clientProtocol = PROTOCOL_VERSION,
): Compatibility {
    const warnings: string[] = [];
    if (doc.bolter > DISCOVERY_VERSION) {
        warnings.push(
            `instance advertises discovery document v${doc.bolter}; this client understands ` +
                `v${DISCOVERY_VERSION} and is ignoring anything newer`,
        );
    }
    if (clientProtocol < doc.protocol.min) {
        return {
            ok: false,
            reason:
                `this instance requires protocol v${doc.protocol.min} or newer, and this ` +
                `client speaks v${clientProtocol} — upgrade the client`,
        };
    }
    if (clientProtocol > doc.protocol.version) {
        warnings.push(
            `instance speaks protocol v${doc.protocol.version}; this client speaks ` +
                `v${clientProtocol} and will stay within the older set`,
        );
    }
    return { ok: true, warnings };
}

function looksLikeInstance(value: unknown): value is InstanceDocument {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const doc = value as Partial<InstanceDocument>;
    return (
        typeof doc.bolter === 'number' &&
        typeof doc.api === 'string' &&
        typeof doc.protocol === 'object' &&
        doc.protocol !== null &&
        typeof doc.protocol.version === 'number'
    );
}

function describeFailure(
    origin: string,
    servedNonJson: boolean,
    interceptedBy: string | null,
): string {
    if (interceptedBy) {
        return (
            `${origin} redirected the request to ${interceptedBy}, which answered with a ` +
            'sign-in page. Something in front of this instance — deployment protection, ' +
            'SSO, a captive portal — is intercepting it, so its API was never reached. ' +
            'Authenticate, disable the protection, or point at the API origin directly.'
        );
    }
    if (servedNonJson) {
        return (
            `${origin} answered, but with a web page rather than a Bolter API. ` +
            'Its API is probably on another origin, and this instance does not publish ' +
            '/instance.json yet — point at the API directly.'
        );
    }
    return `No Bolter instance at ${origin}: neither /instance.json nor /config answered.`;
}

export class InstanceNotFoundError extends Error {
    constructor(
        readonly origin: string,
        /** True when a probe answered 200 with something other than JSON. */
        readonly servedNonJson: boolean,
        /**
         * Origin a probe was redirected to, when it left the instance entirely.
         *
         * This separates "there is no API here" from "we never got to look".
         * Deployment protection answers an unauthenticated probe with a 302 to
         * its own login page; `fetch` follows it, so what comes back is a 200
         * of HTML, indistinguishable from a single-page app answering every
         * path unless the hop is noticed.
         */
        readonly interceptedBy: string | null = null,
    ) {
        super(describeFailure(origin, servedNonJson, interceptedBy));
        this.name = 'InstanceNotFoundError';
    }
}

export interface DiscoverOptions {
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** Milliseconds per probe. Discovery must not hang a CLI startup. */
    timeoutMs?: number;
}

export interface DiscoveredInstance {
    /**
     * Named `instance` rather than `document` on purpose: inside a package
     * that must never touch the DOM, a binding called `document` is exactly
     * the thing a reader has to stop and disambiguate.
     */
    instance: InstanceDocument;
    /** Where it came from, for `doctor` output and diagnostics. */
    source: 'instance.json' | 'api/instance.json' | 'legacy-config';
}

/**
 * Never let a discovery document move the client from TLS to cleartext.
 *
 * The same reasoning as `web` above, applied to the field that matters more:
 * the scheme is not something the document knows better than the caller, which
 * has just completed a request and therefore knows for certain. A document is
 * routinely wrong about it — a backend behind a TLS-terminating proxy sees only
 * the plaintext internal hop, so deriving `api` from its own request URL
 * advertises `http://` to a client that arrived over `https://`.
 *
 * Downgrading is never merely slower. `api` becomes the base URL for every
 * later call, so the edge answers each one with a 301, and the fetch spec
 * rewrites a redirected `POST` into a bodyless `GET` — which is why this
 * surfaces as an inexplicable 404 rather than anything mentioning TLS. On the
 * routes that *are* GET-shaped it is worse than a 404: `Authorization: send-v1`
 * headers and owner tokens would go out in the clear.
 *
 * Only upgrades, never downgrades: a client that spoke plain `http` is talking
 * to local development or a plaintext self-host, and both are legitimate.
 */
function withoutSchemeDowngrade(api: string, base: string): string {
    try {
        const secure = new URL(base).protocol === 'https:';
        const target = new URL(api);
        if (!secure || target.protocol !== 'http:') {
            return api;
        }
        target.protocol = 'https:';
        // `URL` re-serialises with a trailing slash the origin never had.
        return target.origin;
    } catch {
        // Not a URL at all. `looksLikeInstance` only checks that `api` is a
        // string, and inventing a scheme for a malformed value would obscure
        // the error the caller is about to get anyway.
        return api;
    }
}

/**
 * Resolve an origin — typically the one from a share link — to an instance.
 *
 * The `legacy-config` fallback matters: every instance deployed before this
 * document existed still answers `/config`, and refusing to talk to them would
 * make the CLI useless against exactly the self-hosted deployments it is meant
 * to support. The synthesized document is deliberately conservative — it claims
 * only the features that shipped before discovery did.
 */
export async function discoverInstance(
    origin: string,
    options: DiscoverOptions = {},
): Promise<DiscoveredInstance> {
    const base = origin.replace(/\/+$/, '');
    const doFetch: NonNullable<DiscoverOptions['fetch']> = (input, init) =>
        options.fetch ? options.fetch(input, init) : globalThis.fetch(input, init);
    const timeoutMs = options.timeoutMs ?? 5000;

    /**
     * A single-page app answers *every* path with its own HTML and a 200, so
     * "the request succeeded" says nothing. Tracking whether a probe came back
     * as non-JSON is what lets the failure message distinguish "nothing is
     * there" from "something is there, but it is a web app, and the API lives
     * somewhere else" — which is the overwhelmingly common case and needs a
     * completely different fix.
     */
    let sawNonJson = false;
    /** Origin a probe was redirected to, if it left `base` altogether. */
    let interceptedBy: string | null = null;

    const baseOrigin = (() => {
        try {
            return new URL(base).origin;
        } catch {
            return null;
        }
    })();

    const get = async (path: string): Promise<unknown | null> => {
        try {
            const response = await doFetch(`${base}${path}`, {
                signal: AbortSignal.timeout(timeoutMs),
            });
            // Redirects are followed, because same-origin ones are ordinary:
            // http→https, a trailing slash, a canonical host. Only a hop that
            // lands on a *different* origin means the request stopped being
            // about this instance.
            if (response.redirected && baseOrigin) {
                try {
                    const landed = new URL(response.url).origin;
                    if (landed !== baseOrigin) {
                        interceptedBy ??= landed;
                    }
                } catch {
                    // Unparseable final URL tells us nothing; ignore it.
                }
            }
            if (!response.ok) {
                return null;
            }
            // Parse rather than trust `content-type`: a correctly configured
            // instance may omit it, and HTML will not parse as JSON anyway. So
            // this both accepts more real servers and still catches the SPA.
            const body = await response.text();
            try {
                return JSON.parse(body) as unknown;
            } catch {
                sawNonJson = true;
                return null;
            }
        } catch {
            return null;
        }
    };

    for (const [path, source] of [
        ['/instance.json', 'instance.json'],
        // The Docker deployment proxies /api/ to the backend on the web origin.
        ['/api/instance.json', 'api/instance.json'],
    ] as const) {
        const body = await get(path);
        if (looksLikeInstance(body)) {
            // A static document cannot know where it is served from; the
            // client, which just fetched it, can.
            return {
                instance: {
                    ...body,
                    web: body.web || base,
                    api: withoutSchemeDowngrade(body.api, base),
                },
                source,
            };
        }
    }

    const config = await get('/config');
    if (isLegacyConfig(config)) {
        return { instance: fromLegacyConfig(base, config), source: 'legacy-config' };
    }

    throw new InstanceNotFoundError(base, sawNonJson, interceptedBy);
}

interface LegacyConfig {
    LIMITS: {
        MAX_FILE_SIZE: number;
        MAX_FILES_PER_ARCHIVE: number;
        MAX_EXPIRE_SECONDS: number;
        MAX_DOWNLOADS: number;
    };
    DEFAULTS: { EXPIRE_SECONDS: number; DOWNLOADS: number };
    UI?: { TITLE?: string; DESCRIPTION?: string };
}

function isLegacyConfig(value: unknown): value is LegacyConfig {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const config = value as Partial<LegacyConfig>;
    return (
        typeof config.LIMITS?.MAX_FILE_SIZE === 'number' &&
        typeof config.DEFAULTS?.EXPIRE_SECONDS === 'number'
    );
}

function fromLegacyConfig(base: string, config: LegacyConfig): InstanceDocument {
    return {
        bolter: DISCOVERY_VERSION,
        name: config.UI?.TITLE || 'Bolter',
        description: config.UI?.DESCRIPTION,
        // An instance answering /config on this origin *is* the API; whether it
        // also serves the web app is unknowable from here, so assume shared.
        web: base,
        api: base,
        protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION },
        features: ['multipart', 'resume', 'ece-v1', 'owner-tokens', 'password', 'zip-at-upload'],
        limits: {
            maxFileSize: config.LIMITS.MAX_FILE_SIZE,
            maxFilesPerArchive: config.LIMITS.MAX_FILES_PER_ARCHIVE,
            maxExpireSeconds: config.LIMITS.MAX_EXPIRE_SECONDS,
            maxDownloads: config.LIMITS.MAX_DOWNLOADS,
            multipartThreshold: 100 * 1000 * 1000,
            minPartSize: 5 * 1024 * 1024,
            maxParts: 10000,
            maxMetadataBytes: 512 * 1024,
        },
        defaults: {
            expireSeconds: config.DEFAULTS.EXPIRE_SECONDS,
            downloads: config.DEFAULTS.DOWNLOADS,
        },
    };
}
