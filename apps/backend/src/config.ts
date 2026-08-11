// Configuration for Bolter backend
import { DOWNLOAD_LIMITS, TIME_LIMITS, UI_DEFAULTS, UPLOAD_LIMITS } from '@bolter/shared';

export interface Config {
    // S3 Configuration
    s3Bucket: string;
    s3Endpoint: string;
    s3UsePathStyle: boolean;

    // Redis Configuration
    redisUrl: string;

    // Server Configuration
    port: number;
    baseUrl: string;
    env: 'development' | 'production' | 'test';
    /**
     * True ONLY when NODE_ENV is explicitly `development`. Anything else —
     * including an unset or unrecognised NODE_ENV — is treated as production
     * so the shipped deployment fails closed (see CORS in `app.ts`).
     */
    isDevelopment: boolean;
    /** Extra browser origins allowed by CORS in addition to `baseUrl`. */
    corsOrigins: string[];

    // Limits
    maxFileSize: number;
    maxFilesPerArchive: number;
    /** Byte ceiling on the base64 metadata blob stored per file. */
    maxMetadataBytes: number;
    /** Global request-body ceiling handed to Bun via Elysia's `serve`. */
    maxRequestBodyBytes: number;
    maxExpireSeconds: number;
    maxDownloads: number;

    // Defaults
    defaultExpireSeconds: number;
    defaultDownloads: number;
    expireTimesSeconds: number[];
    downloadCounts: number[];

    // UI Configuration
    customTitle: string;
    customDescription: string;

    // Provider Management
    providerEncryptionKey: string;
    providerCacheTtlSeconds: number;
    adminApiKey: string;

    // Health probes
    /**
     * How long a health probe result is reused. Should be >= the probe interval
     * of whatever is polling `/health*` (the shipped compose healthcheck uses
     * 30s), otherwise every scheduled probe misses the cache.
     */
    healthCacheTtlSeconds: number;
    /**
     * Per-dependency budget for a single health probe. The S3 client sets no
     * request timeout of its own, so without this a black-holing bucket would
     * stall every probe for the socket timeout and flap readiness.
     */
    healthProbeTimeoutMs: number;

    // Analytics proxy
    /** Site domains this deployment is allowed to report Plausible events for. */
    plausibleDomains: string[];
    /**
     * CIDR ranges of the edge/proxy tier that is allowed to set
     * `cf-connecting-ip`. Empty means "no peer check" (legacy behaviour).
     */
    trustedEdgeCidrs: string[];
}

const VALID_ENVS = ['development', 'production', 'test'] as const;
type EnvName = (typeof VALID_ENVS)[number];

/** Default site domain reported by the shipped frontend (`lib/plausible.ts`). */
const DEFAULT_PLAUSIBLE_DOMAIN = 'send.fm';

export interface ConfigLoadResult {
    config: Config;
    errors: string[];
    warnings: string[];
}

/**
 * Resolve NODE_ENV fail-closed: only the exact strings `development`,
 * `production` and `test` are honoured. Unset or unrecognised values fall back
 * to production behaviour so a forgotten env var can never open up CORS.
 */
export function resolveEnvName(raw: string | undefined): { env: EnvName; warning?: string } {
    const value = raw?.trim();
    if (!value) {
        return {
            env: 'production',
            warning: 'NODE_ENV is not set — assuming "production" (fail-closed).',
        };
    }
    if ((VALID_ENVS as readonly string[]).includes(value)) {
        return { env: value as EnvName };
    }
    return {
        env: 'production',
        warning: `NODE_ENV="${value}" is not one of ${VALID_ENVS.join(' | ')} — assuming "production" (fail-closed).`,
    };
}

export interface NumericEnvOptions {
    min?: number;
    max?: number;
}

/**
 * Parse a numeric environment variable strictly.
 *
 * `parseInt` silently accepted `'10GB'` as `10` and `'abc'` as `NaN` (which
 * removes limits entirely, because `size > NaN` is always false). `Number()`
 * plus explicit finite/integer/range checks makes both cases loud failures.
 *
 * Returns `fallback` and pushes a message onto `errors` when the value is bad,
 * so the caller can report every problem at once before exiting.
 */
export function parseNumericEnv(
    name: string,
    raw: string | undefined,
    fallback: number,
    errors: string[],
    options: NumericEnvOptions = {},
): number {
    const { min = 0, max = Number.MAX_SAFE_INTEGER } = options;
    const value = raw?.trim();
    if (value === undefined || value === '') {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        errors.push(`${name}="${value}" is not a number.`);
        return fallback;
    }
    if (!Number.isInteger(parsed)) {
        errors.push(`${name}="${value}" must be an integer.`);
        return fallback;
    }
    if (parsed < min || parsed > max) {
        errors.push(`${name}="${value}" must be between ${min} and ${max}.`);
        return fallback;
    }
    return parsed;
}

/**
 * Parse a comma-separated list of positive integers. Unlike the previous
 * implementation, malformed entries are reported instead of silently dropped.
 */
export function parseIntArrayEnv(
    name: string,
    raw: string | undefined,
    fallback: number[],
    errors: string[],
): number[] {
    const value = raw?.trim();
    if (!value) {
        return fallback;
    }

    const entries = value.split(',').map((v) => v.trim());
    const parsed: number[] = [];
    for (const entry of entries) {
        if (entry === '') {
            continue;
        }
        const n = Number(entry);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
            errors.push(`${name} entry "${entry}" must be a positive integer.`);
            return fallback;
        }
        parsed.push(n);
    }

    if (parsed.length === 0) {
        errors.push(`${name}="${value}" contains no usable values.`);
        return fallback;
    }
    return parsed;
}

function parseStringList(raw: string | undefined, fallback: string[]): string[] {
    const value = raw?.trim();
    if (!value) {
        return fallback;
    }
    const parsed = value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
    return parsed.length > 0 ? parsed : fallback;
}

/**
 * Build (and validate) the configuration from an environment bag.
 *
 * Pure and side-effect free so it can be unit-tested; `loadConfig` is the thin
 * wrapper that reports and exits on failure.
 */
export function buildConfig(env: Record<string, string | undefined>): ConfigLoadResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const { env: envName, warning: envWarning } = resolveEnvName(env.NODE_ENV);
    if (envWarning) {
        warnings.push(envWarning);
    }

    const s3Bucket = (env.S3_BUCKET || '').trim();
    const s3Endpoint = (env.S3_ENDPOINT || '').trim();
    // Tests run without real storage credentials; every other environment must
    // have a bucket or the deployment cannot serve a single request.
    if (envName !== 'test') {
        if (!s3Bucket) {
            errors.push('S3_BUCKET is required and must not be empty.');
        }
        if (!s3Endpoint) {
            errors.push('S3_ENDPOINT is required and must not be empty.');
        }
    }

    const config: Config = {
        // S3
        s3Bucket,
        s3Endpoint,
        s3UsePathStyle: env.S3_USE_PATH_STYLE_ENDPOINT === 'true',

        // Redis
        redisUrl: env.REDIS_URL || 'redis://localhost:6379',

        // Server
        port: parseNumericEnv('PORT', env.PORT, 3001, errors, { min: 1, max: 65535 }),
        baseUrl: env.BASE_URL || 'http://localhost:3001',
        env: envName,
        isDevelopment: envName === 'development',
        corsOrigins: parseStringList(env.CORS_ORIGINS, []),

        // Limits
        maxFileSize: parseNumericEnv(
            'MAX_FILE_SIZE',
            env.MAX_FILE_SIZE,
            UPLOAD_LIMITS.MAX_FILE_SIZE,
            errors,
            { min: 1 },
        ),
        maxFilesPerArchive: parseNumericEnv(
            'MAX_FILES_PER_ARCHIVE',
            env.MAX_FILES_PER_ARCHIVE,
            UPLOAD_LIMITS.MAX_FILES_PER_ARCHIVE,
            errors,
            { min: 1 },
        ),
        maxMetadataBytes: parseNumericEnv(
            'MAX_METADATA_BYTES',
            env.MAX_METADATA_BYTES,
            UPLOAD_LIMITS.MAX_METADATA_BYTES,
            errors,
            { min: 1 },
        ),
        maxRequestBodyBytes: parseNumericEnv(
            'MAX_REQUEST_BODY_BYTES',
            env.MAX_REQUEST_BODY_BYTES,
            UPLOAD_LIMITS.MAX_REQUEST_BODY_BYTES,
            errors,
            { min: 1 },
        ),
        maxExpireSeconds: parseNumericEnv(
            'MAX_EXPIRE_SECONDS',
            env.MAX_EXPIRE_SECONDS,
            TIME_LIMITS.MAX_EXPIRE_SECONDS,
            errors,
            { min: 1 },
        ),
        maxDownloads: parseNumericEnv(
            'MAX_DOWNLOADS',
            env.MAX_DOWNLOADS,
            DOWNLOAD_LIMITS.MAX_DOWNLOADS,
            errors,
            { min: 1 },
        ),

        // Defaults
        defaultExpireSeconds: parseNumericEnv(
            'DEFAULT_EXPIRE_SECONDS',
            env.DEFAULT_EXPIRE_SECONDS,
            TIME_LIMITS.DEFAULT_EXPIRE_SECONDS,
            errors,
            { min: 1 },
        ),
        defaultDownloads: parseNumericEnv(
            'DEFAULT_DOWNLOADS',
            env.DEFAULT_DOWNLOADS,
            DOWNLOAD_LIMITS.DEFAULT_DOWNLOADS,
            errors,
            { min: 1 },
        ),
        expireTimesSeconds: parseIntArrayEnv(
            'EXPIRE_TIMES_SECONDS',
            env.EXPIRE_TIMES_SECONDS,
            [...TIME_LIMITS.EXPIRE_TIMES],
            errors,
        ),
        downloadCounts: parseIntArrayEnv(
            'DOWNLOAD_COUNTS',
            env.DOWNLOAD_COUNTS,
            [...DOWNLOAD_LIMITS.DOWNLOAD_COUNTS],
            errors,
        ),

        // UI
        customTitle: env.CUSTOM_TITLE || UI_DEFAULTS.TITLE,
        customDescription: env.CUSTOM_DESCRIPTION || UI_DEFAULTS.DESCRIPTION,

        // Provider Management
        providerEncryptionKey: env.PROVIDER_ENCRYPTION_KEY || '',
        providerCacheTtlSeconds: parseNumericEnv(
            'PROVIDER_CACHE_TTL_SECONDS',
            env.PROVIDER_CACHE_TTL_SECONDS,
            60,
            errors,
            { min: 1 },
        ),
        adminApiKey: env.ADMIN_API_KEY || '',

        // Health probes
        healthCacheTtlSeconds: parseNumericEnv(
            'HEALTH_CACHE_TTL_SECONDS',
            env.HEALTH_CACHE_TTL_SECONDS,
            30,
            errors,
            { min: 0, max: 3600 },
        ),
        healthProbeTimeoutMs: parseNumericEnv(
            'HEALTH_PROBE_TIMEOUT_MS',
            env.HEALTH_PROBE_TIMEOUT_MS,
            2000,
            errors,
            { min: 1, max: 60_000 },
        ),

        // Analytics proxy
        plausibleDomains: parseStringList(env.PLAUSIBLE_DOMAINS, [DEFAULT_PLAUSIBLE_DOMAIN]).map(
            (d) => d.toLowerCase(),
        ),
        trustedEdgeCidrs: parseStringList(env.TRUSTED_EDGE_CIDRS, []),
    };

    // Defaults must be reachable through the advertised limits, otherwise the
    // server hands clients a default it will later reject.
    if (config.defaultExpireSeconds > config.maxExpireSeconds) {
        errors.push(
            `DEFAULT_EXPIRE_SECONDS (${config.defaultExpireSeconds}) must not exceed MAX_EXPIRE_SECONDS (${config.maxExpireSeconds}).`,
        );
    }
    if (config.defaultDownloads > config.maxDownloads) {
        errors.push(
            `DEFAULT_DOWNLOADS (${config.defaultDownloads}) must not exceed MAX_DOWNLOADS (${config.maxDownloads}).`,
        );
    }

    return { config, errors, warnings };
}

function loadConfig(): Config {
    const { config: parsed, errors, warnings } = buildConfig(process.env);

    // `logger` imports this module, so plain console is the only option here.
    for (const warning of warnings) {
        console.warn(`[config] ${warning}`);
    }

    if (errors.length > 0) {
        console.error('[config] Invalid environment configuration — refusing to start:');
        for (const error of errors) {
            console.error(`[config]   - ${error}`);
        }
        process.exit(1);
    }

    return parsed;
}

export const config: Config = loadConfig();

export function deriveBaseUrl(request: Request): string {
    if (process.env.DETECT_BASE_URL === 'true') {
        const url = new URL(request.url);
        return `${url.protocol}//${url.host}`;
    }
    return config.baseUrl;
}
