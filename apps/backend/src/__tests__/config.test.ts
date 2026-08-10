import { afterEach, describe, expect, it } from 'bun:test';
import { DOWNLOAD_LIMITS, TIME_LIMITS, UI_DEFAULTS, UPLOAD_LIMITS } from '@bolter/shared';

// Import the config and deriveBaseUrl from the backend config module.
// Since config reads process.env at import time, we test deriveBaseUrl dynamically
// and spot-check the default config values.
import {
    buildConfig,
    config,
    deriveBaseUrl,
    parseIntArrayEnv,
    parseNumericEnv,
    resolveEnvName,
} from '../config';

describe('deriveBaseUrl', () => {
    const originalDetectBaseUrl = process.env.DETECT_BASE_URL;

    afterEach(() => {
        // Restore the original value
        if (originalDetectBaseUrl === undefined) {
            delete process.env.DETECT_BASE_URL;
        } else {
            process.env.DETECT_BASE_URL = originalDetectBaseUrl;
        }
    });

    it('should extract protocol and host from request when DETECT_BASE_URL=true', () => {
        process.env.DETECT_BASE_URL = 'true';

        const request = new Request('https://example.com:8443/some/path?query=1');
        const result = deriveBaseUrl(request);

        expect(result).toBe('https://example.com:8443');
    });

    it('should extract http protocol correctly when DETECT_BASE_URL=true', () => {
        process.env.DETECT_BASE_URL = 'true';

        const request = new Request('http://localhost:3001/upload/url');
        const result = deriveBaseUrl(request);

        expect(result).toBe('http://localhost:3001');
    });

    it('should return config.baseUrl when DETECT_BASE_URL is not set', () => {
        delete process.env.DETECT_BASE_URL;

        const request = new Request('https://example.com/some/path');
        const result = deriveBaseUrl(request);

        expect(result).toBe(config.baseUrl);
    });

    it('should return config.baseUrl when DETECT_BASE_URL is "false"', () => {
        process.env.DETECT_BASE_URL = 'false';

        const request = new Request('https://example.com/some/path');
        const result = deriveBaseUrl(request);

        expect(result).toBe(config.baseUrl);
    });

    it('should strip path and query from detected URL', () => {
        process.env.DETECT_BASE_URL = 'true';

        const request = new Request('https://api.example.com/v1/upload?foo=bar#hash');
        const result = deriveBaseUrl(request);

        expect(result).toBe('https://api.example.com');
        expect(result).not.toContain('/v1');
        expect(result).not.toContain('foo');
    });

    it('should handle default port (443 for https)', () => {
        process.env.DETECT_BASE_URL = 'true';

        const request = new Request('https://example.com/path');
        const result = deriveBaseUrl(request);

        // Default port should not appear in the URL
        expect(result).toBe('https://example.com');
    });
});

describe('config default values', () => {
    it('should default port to 3001', () => {
        // Unless PORT env var is set, default is 3001
        expect(config.port).toBe(parseInt(process.env.PORT || '3001', 10));
    });

    it('should resolve env from NODE_ENV, failing closed to production', () => {
        // Finding #6: an unset/unknown NODE_ENV used to resolve to
        // "development", which turns on origin-reflecting CORS with credentials.
        const raw = process.env.NODE_ENV;
        const expected =
            raw === 'development' || raw === 'production' || raw === 'test' ? raw : 'production';
        expect(config.env).toBe(expected);
        expect(config.isDevelopment).toBe(process.env.NODE_ENV === 'development');
    });

    it('should default baseUrl to "http://localhost:3001"', () => {
        expect(config.baseUrl).toBe(process.env.BASE_URL || 'http://localhost:3001');
    });

    it('should default redisUrl to "redis://localhost:6379"', () => {
        expect(config.redisUrl).toBe(process.env.REDIS_URL || 'redis://localhost:6379');
    });

    it('should default maxFileSize to UPLOAD_LIMITS.MAX_FILE_SIZE', () => {
        if (!process.env.MAX_FILE_SIZE) {
            expect(config.maxFileSize).toBe(UPLOAD_LIMITS.MAX_FILE_SIZE);
        }
    });

    it('should default maxFilesPerArchive to UPLOAD_LIMITS.MAX_FILES_PER_ARCHIVE', () => {
        if (!process.env.MAX_FILES_PER_ARCHIVE) {
            expect(config.maxFilesPerArchive).toBe(UPLOAD_LIMITS.MAX_FILES_PER_ARCHIVE);
        }
    });

    it('should default maxExpireSeconds to TIME_LIMITS.MAX_EXPIRE_SECONDS', () => {
        if (!process.env.MAX_EXPIRE_SECONDS) {
            expect(config.maxExpireSeconds).toBe(TIME_LIMITS.MAX_EXPIRE_SECONDS);
        }
    });

    it('should default maxDownloads to DOWNLOAD_LIMITS.MAX_DOWNLOADS', () => {
        if (!process.env.MAX_DOWNLOADS) {
            expect(config.maxDownloads).toBe(DOWNLOAD_LIMITS.MAX_DOWNLOADS);
        }
    });

    it('should default defaultExpireSeconds to TIME_LIMITS.DEFAULT_EXPIRE_SECONDS', () => {
        if (!process.env.DEFAULT_EXPIRE_SECONDS) {
            expect(config.defaultExpireSeconds).toBe(TIME_LIMITS.DEFAULT_EXPIRE_SECONDS);
        }
    });

    it('should default defaultDownloads to DOWNLOAD_LIMITS.DEFAULT_DOWNLOADS', () => {
        if (!process.env.DEFAULT_DOWNLOADS) {
            expect(config.defaultDownloads).toBe(DOWNLOAD_LIMITS.DEFAULT_DOWNLOADS);
        }
    });

    it('should default expireTimesSeconds to TIME_LIMITS.EXPIRE_TIMES', () => {
        if (!process.env.EXPIRE_TIMES_SECONDS) {
            expect(config.expireTimesSeconds).toEqual([...TIME_LIMITS.EXPIRE_TIMES]);
        }
    });

    it('should default downloadCounts to DOWNLOAD_LIMITS.DOWNLOAD_COUNTS', () => {
        if (!process.env.DOWNLOAD_COUNTS) {
            expect(config.downloadCounts).toEqual([...DOWNLOAD_LIMITS.DOWNLOAD_COUNTS]);
        }
    });

    it('should default customTitle to UI_DEFAULTS.TITLE', () => {
        if (!process.env.CUSTOM_TITLE) {
            expect(config.customTitle).toBe(UI_DEFAULTS.TITLE);
        }
    });

    it('should default customDescription to UI_DEFAULTS.DESCRIPTION', () => {
        if (!process.env.CUSTOM_DESCRIPTION) {
            expect(config.customDescription).toBe(UI_DEFAULTS.DESCRIPTION);
        }
    });
});

// ---------------------------------------------------------------------------
// Finding #6 — NODE_ENV must be validated against the known enum and fail
// closed to production behaviour on anything unexpected.
// ---------------------------------------------------------------------------

describe('resolveEnvName (finding #6)', () => {
    it('defaults to production when NODE_ENV is unset', () => {
        const result = resolveEnvName(undefined);

        expect(result.env).toBe('production');
        expect(result.warning).toBeTruthy();
    });

    it('defaults to production when NODE_ENV is empty or whitespace', () => {
        expect(resolveEnvName('').env).toBe('production');
        expect(resolveEnvName('   ').env).toBe('production');
    });

    it('defaults to production for unrecognised values', () => {
        for (const value of ['staging', 'Development', 'DEV', 'prod', 'devlopment']) {
            const result = resolveEnvName(value);
            expect(result.env).toBe('production');
            expect(result.warning).toContain(value);
        }
    });

    it('honours each known environment exactly', () => {
        expect(resolveEnvName('development')).toEqual({ env: 'development' });
        expect(resolveEnvName('production')).toEqual({ env: 'production' });
        expect(resolveEnvName('test')).toEqual({ env: 'test' });
    });
});

describe('buildConfig environment resolution (finding #6)', () => {
    const baseEnv = { S3_BUCKET: 'bucket', S3_ENDPOINT: 'https://s3.example.com' };

    it('marks an unset NODE_ENV as production and not development', () => {
        const { config: parsed, warnings } = buildConfig({ ...baseEnv });

        expect(parsed.env).toBe('production');
        expect(parsed.isDevelopment).toBe(false);
        expect(warnings.length).toBeGreaterThan(0);
    });

    it('marks a garbage NODE_ENV as production and not development', () => {
        const { config: parsed } = buildConfig({ ...baseEnv, NODE_ENV: 'developement' });

        expect(parsed.env).toBe('production');
        expect(parsed.isDevelopment).toBe(false);
    });

    it('only enables development for the exact string "development"', () => {
        expect(buildConfig({ ...baseEnv, NODE_ENV: 'development' }).config.isDevelopment).toBe(
            true,
        );
        expect(buildConfig({ ...baseEnv, NODE_ENV: 'production' }).config.isDevelopment).toBe(
            false,
        );
        expect(buildConfig({ ...baseEnv, NODE_ENV: 'test' }).config.isDevelopment).toBe(false);
    });

    it('parses CORS_ORIGINS into a list, defaulting to empty', () => {
        expect(buildConfig({ ...baseEnv }).config.corsOrigins).toEqual([]);
        expect(
            buildConfig({
                ...baseEnv,
                CORS_ORIGINS: 'https://send.fm, https://www.send.fm',
            }).config.corsOrigins,
        ).toEqual(['https://send.fm', 'https://www.send.fm']);
    });
});

// ---------------------------------------------------------------------------
// Finding #9 — malformed numeric env vars must be rejected at startup instead
// of silently disabling limits (NaN) or truncating them (parseInt).
// ---------------------------------------------------------------------------

describe('parseNumericEnv (finding #9)', () => {
    it('returns the fallback when unset or empty', () => {
        const errors: string[] = [];

        expect(parseNumericEnv('X', undefined, 42, errors)).toBe(42);
        expect(parseNumericEnv('X', '', 42, errors)).toBe(42);
        expect(parseNumericEnv('X', '   ', 42, errors)).toBe(42);
        expect(errors).toEqual([]);
    });

    it('parses valid integers', () => {
        const errors: string[] = [];

        expect(parseNumericEnv('X', '1000', 42, errors)).toBe(1000);
        expect(parseNumericEnv('X', ' 7 ', 42, errors)).toBe(7);
        expect(errors).toEqual([]);
    });

    it('rejects non-numeric values instead of yielding NaN', () => {
        const errors: string[] = [];
        const value = parseNumericEnv('MAX_FILE_SIZE', 'abc', 99, errors);

        expect(Number.isNaN(value)).toBe(false);
        expect(value).toBe(99);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('MAX_FILE_SIZE');
    });

    it('rejects unit-suffixed values instead of silently truncating them', () => {
        // parseInt('10GB') === 10 — a 10-byte upload cap.
        const errors: string[] = [];
        const value = parseNumericEnv('MAX_FILE_SIZE', '10GB', 1_000, errors);

        expect(value).toBe(1_000);
        expect(errors).toHaveLength(1);
    });

    it('rejects negative, fractional and out-of-range values', () => {
        const errors: string[] = [];

        expect(parseNumericEnv('A', '-1', 5, errors, { min: 1 })).toBe(5);
        expect(parseNumericEnv('B', '1.5', 5, errors)).toBe(5);
        expect(parseNumericEnv('C', 'Infinity', 5, errors)).toBe(5);
        expect(parseNumericEnv('D', '70000', 5, errors, { min: 1, max: 65535 })).toBe(5);
        expect(errors).toHaveLength(4);
    });
});

describe('parseIntArrayEnv (finding #9)', () => {
    it('returns the fallback when unset', () => {
        const errors: string[] = [];

        expect(parseIntArrayEnv('EXPIRE_TIMES_SECONDS', undefined, [1, 2], errors)).toEqual([1, 2]);
        expect(errors).toEqual([]);
    });

    it('parses a comma separated list', () => {
        const errors: string[] = [];

        expect(parseIntArrayEnv('EXPIRE_TIMES_SECONDS', '300, 3600,86400', [1], errors)).toEqual([
            300, 3600, 86400,
        ]);
        expect(errors).toEqual([]);
    });

    it('reports malformed entries instead of silently dropping them', () => {
        const errors: string[] = [];
        const value = parseIntArrayEnv('DOWNLOAD_COUNTS', '1,two,3', [9], errors);

        expect(value).toEqual([9]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('DOWNLOAD_COUNTS');
    });
});

describe('buildConfig validation (finding #9)', () => {
    const baseEnv = {
        NODE_ENV: 'production',
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'https://s3.example.com',
    };

    it('accepts a well-formed environment with no errors', () => {
        const { errors } = buildConfig({ ...baseEnv, MAX_FILE_SIZE: '1000000' });

        expect(errors).toEqual([]);
    });

    it('never produces a NaN limit that would disable the size cap', () => {
        const { config: parsed, errors } = buildConfig({ ...baseEnv, MAX_FILE_SIZE: 'abc' });

        // Pre-fix this was NaN, and `fileSize > NaN` is always false.
        expect(Number.isNaN(parsed.maxFileSize)).toBe(false);
        expect(errors.some((e) => e.includes('MAX_FILE_SIZE'))).toBe(true);
    });

    it('rejects a unit-suffixed MAX_EXPIRE_SECONDS instead of producing a 6 second TTL', () => {
        const { config: parsed, errors } = buildConfig({
            ...baseEnv,
            MAX_EXPIRE_SECONDS: '6months',
        });

        expect(parsed.maxExpireSeconds).not.toBe(6);
        expect(errors.some((e) => e.includes('MAX_EXPIRE_SECONDS'))).toBe(true);
    });

    it('rejects a NaN DEFAULT_DOWNLOADS that would store dlimit="NaN"', () => {
        const { config: parsed, errors } = buildConfig({ ...baseEnv, DEFAULT_DOWNLOADS: 'one' });

        expect(Number.isNaN(parsed.defaultDownloads)).toBe(false);
        expect(errors.some((e) => e.includes('DEFAULT_DOWNLOADS'))).toBe(true);
    });

    it('rejects a negative limit', () => {
        const { errors } = buildConfig({ ...baseEnv, MAX_DOWNLOADS: '-5' });

        expect(errors.some((e) => e.includes('MAX_DOWNLOADS'))).toBe(true);
    });

    it('rejects an out-of-range PORT', () => {
        expect(buildConfig({ ...baseEnv, PORT: '0' }).errors.length).toBeGreaterThan(0);
        expect(buildConfig({ ...baseEnv, PORT: '99999' }).errors.length).toBeGreaterThan(0);
        expect(buildConfig({ ...baseEnv, PORT: '8080' }).errors).toEqual([]);
    });

    it('collects every problem instead of stopping at the first', () => {
        const { errors } = buildConfig({
            ...baseEnv,
            MAX_FILE_SIZE: 'abc',
            MAX_DOWNLOADS: 'xyz',
            PORT: 'nope',
        });

        expect(errors.length).toBeGreaterThanOrEqual(3);
    });

    it('requires S3_BUCKET and S3_ENDPOINT outside the test environment', () => {
        const { errors } = buildConfig({ NODE_ENV: 'production' });

        expect(errors.some((e) => e.includes('S3_BUCKET'))).toBe(true);
        expect(errors.some((e) => e.includes('S3_ENDPOINT'))).toBe(true);
    });

    it('treats whitespace-only S3 settings as missing', () => {
        const { errors } = buildConfig({
            NODE_ENV: 'production',
            S3_BUCKET: '   ',
            S3_ENDPOINT: '   ',
        });

        expect(errors.some((e) => e.includes('S3_BUCKET'))).toBe(true);
        expect(errors.some((e) => e.includes('S3_ENDPOINT'))).toBe(true);
    });

    it('does not require S3 settings under NODE_ENV=test', () => {
        const { errors } = buildConfig({ NODE_ENV: 'test' });

        expect(errors).toEqual([]);
    });

    it('rejects defaults that exceed their advertised maximum', () => {
        const tooLongExpiry = buildConfig({
            ...baseEnv,
            MAX_EXPIRE_SECONDS: '3600',
            DEFAULT_EXPIRE_SECONDS: '86400',
        });
        const tooManyDownloads = buildConfig({
            ...baseEnv,
            MAX_DOWNLOADS: '5',
            DEFAULT_DOWNLOADS: '50',
        });

        expect(tooLongExpiry.errors.some((e) => e.includes('DEFAULT_EXPIRE_SECONDS'))).toBe(true);
        expect(tooManyDownloads.errors.some((e) => e.includes('DEFAULT_DOWNLOADS'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Finding #29 — health probe timing must be operator-tunable and validated, so
// a deployment can align the cache TTL with its own probe interval.
// ---------------------------------------------------------------------------

describe('health probe config (finding #29)', () => {
    const baseEnv = {
        NODE_ENV: 'production',
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'https://s3.example.com',
    };

    it('defaults the cache TTL to at least the shipped 30s probe interval', () => {
        const { config: parsed, errors } = buildConfig(baseEnv);

        expect(errors).toEqual([]);
        expect(parsed.healthCacheTtlSeconds).toBeGreaterThanOrEqual(30);
    });

    it('defaults to a bounded per-dependency probe timeout', () => {
        const { config: parsed } = buildConfig(baseEnv);

        expect(parsed.healthProbeTimeoutMs).toBeGreaterThan(0);
        expect(parsed.healthProbeTimeoutMs).toBeLessThanOrEqual(10_000);
    });

    it('honours an operator-supplied TTL and timeout', () => {
        const { config: parsed, errors } = buildConfig({
            ...baseEnv,
            HEALTH_CACHE_TTL_SECONDS: '120',
            HEALTH_PROBE_TIMEOUT_MS: '750',
        });

        expect(errors).toEqual([]);
        expect(parsed.healthCacheTtlSeconds).toBe(120);
        expect(parsed.healthProbeTimeoutMs).toBe(750);
    });

    it('rejects a malformed or unbounded probe timeout', () => {
        expect(
            buildConfig({ ...baseEnv, HEALTH_PROBE_TIMEOUT_MS: 'forever' }).errors.some((e) =>
                e.includes('HEALTH_PROBE_TIMEOUT_MS'),
            ),
        ).toBe(true);
        expect(
            buildConfig({ ...baseEnv, HEALTH_PROBE_TIMEOUT_MS: '0' }).errors.some((e) =>
                e.includes('HEALTH_PROBE_TIMEOUT_MS'),
            ),
        ).toBe(true);
        expect(
            buildConfig({ ...baseEnv, HEALTH_CACHE_TTL_SECONDS: '5m' }).errors.some((e) =>
                e.includes('HEALTH_CACHE_TTL_SECONDS'),
            ),
        ).toBe(true);
    });
});
