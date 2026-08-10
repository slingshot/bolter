import { describe, expect, it } from 'vitest';
import { getConcurrentUploads, isRetryableError, retryDelayMs } from '../upload-shared';

describe('upload-shared', () => {
    it('is importable without DOM globals', async () => {
        // happy-dom rewrites import.meta.url to an http: URL, so resolve the
        // source path from the vitest cwd (apps/frontend) instead.
        const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
        const src = fs.readFileSync(
            path.resolve(process.cwd(), 'src/lib/upload-shared.ts'),
            'utf8',
        );
        expect(src).not.toMatch(/\bwindow\b|\bdocument\b|navigator\.onLine/);
    });
    it('returns bounded concurrency for every file size', () => {
        // Concurrency deliberately drops above 50GB (conservative for R2), so
        // assert sane bounds rather than monotonic growth.
        expect(getConcurrentUploads(1)).toBeGreaterThanOrEqual(1);
        expect(getConcurrentUploads(100 * 1024 ** 3)).toBeGreaterThanOrEqual(1);
        expect(getConcurrentUploads(100 * 1024 ** 3)).toBeLessThanOrEqual(getConcurrentUploads(1));
    });
    it('classifies network-ish errors as retryable', () => {
        expect(isRetryableError(new Error('network error'))).toBe(true);
    });
    it('backoff grows with attempt', () => {
        expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
    });
});
