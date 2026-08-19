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

    const get = async (path: string): Promise<unknown | null> => {
        try {
            const response = await doFetch(`${base}${path}`, {
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) {
                return null;
            }
            return await response.json();
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
            return { instance: { ...body, web: body.web || base }, source };
        }
    }

    const config = await get('/config');
    if (isLegacyConfig(config)) {
        return { instance: fromLegacyConfig(base, config), source: 'legacy-config' };
    }

    throw new Error(
        `no Bolter instance at ${base}: neither /instance.json nor /config answered in a ` +
            'recognisable shape',
    );
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
