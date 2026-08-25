/**
 * Retry classification and backoff, shared by every Bolter client.
 *
 * Nothing here may touch host-specific globals: the same code runs on the
 * main thread, inside a dedicated Web Worker, and in a compiled Bun binary.
 * `__tests__/no-host-globals.test.ts` enforces that across the package.
 */

// Retry backoff configuration
const RETRY_DELAY_BASE = 2000; // 2 seconds
const MAX_RETRY_DELAY = 60000; // 60 seconds

// Adaptive concurrency based on file size
// R2 limits concurrent part uploads to ~2-3 per upload ID, so we cap at 3.
// With backpressure, memory is bounded to ~(concurrency + 1) * partSize
// e.g., concurrency 3 with 200MB parts = max ~800MB buffered
export function getConcurrentUploads(fileSize: number): number {
    const GB = 1024 * 1024 * 1024;
    if (fileSize > 50 * GB) {
        return 2; // > 50GB: conservative for R2
    }
    return 3; // default: 3 concurrent uploads (R2 limit)
}

/**
 * Check if an error is retryable
 * Includes browser abort errors (NS_BINDING_ABORTED in Firefox) which often happen
 * due to memory pressure or connection limits
 */
export function isRetryableError(error: Error): boolean {
    const msg = (error.message || '').toLowerCase();
    return (
        msg.includes('network error') ||
        msg.includes('network') ||
        msg.includes('timeout') ||
        msg.includes('abort') ||
        msg.includes('stalled') ||
        msg.includes('failed to fetch') ||
        /http 5\d\d/.test(msg) ||
        msg.includes('http 429') ||
        msg.includes('http 408') ||
        msg.includes('http 0') // Often indicates network failure
    );
}

/**
 * Exponential backoff with jitter for upload retries: 2s base doubling per
 * attempt (0-based) plus up to 1s of random jitter, capped at 60s.
 */
export function retryDelayMs(attempt: number): number {
    return Math.min(RETRY_DELAY_BASE * 2 ** attempt + Math.random() * 1000, MAX_RETRY_DELAY);
}
