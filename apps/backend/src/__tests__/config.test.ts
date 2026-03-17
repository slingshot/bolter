import { afterEach, describe, expect, it } from 'bun:test';
import { DOWNLOAD_LIMITS, TIME_LIMITS, UI_DEFAULTS, UPLOAD_LIMITS } from '@bolter/shared';

// Import the config and deriveBaseUrl from the backend config module.
// Since config reads process.env at import time, we test deriveBaseUrl dynamically
// and spot-check the default config values.
import { config, deriveBaseUrl } from '../config';

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

    it('should default env to "development"', () => {
        const expected = (process.env.NODE_ENV as string) || 'development';
        expect(config.env).toBe(expected);
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
