import { describe, expect, it } from 'bun:test';
import { getConcurrentUploads, isRetryableError, retryDelayMs } from '../src/retry';

describe('retry', () => {
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
