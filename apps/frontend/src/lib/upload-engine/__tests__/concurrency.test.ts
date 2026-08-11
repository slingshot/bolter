import { PART_SIZING } from '@bolter/shared';
import { describe, expect, it } from 'vitest';
import { createConcurrencyController, isPushbackError } from '../concurrency';
import { deriveConcurrency } from '../engine';

const MiB = 1024 * 1024;

const BUDGET = 640 * MiB;

/**
 * Largest part size the budget can actually hold: above 128 MiB the MIN_WINDOW
 * floor (3 staged + 2 in flight = 5 parts) already exceeds it. The floor
 * deliberately outranks the budget there — a window that cannot stage ahead of
 * the uploader pool starves it — and the overshoot peaks at 650 MiB.
 */
const BUDGET_BINDS_UP_TO_MiB = 128;

/**
 * Peak OPFS residency, which is NOT `windowSize * partSize`.
 *
 * A window slot frees when an uploader *picks a part up*, but the bytes stay on
 * disk for the whole transfer because every attempt re-reads them. So staged
 * parts and in-flight parts are resident simultaneously. Asserting on the
 * window alone re-states the formula instead of measuring the footprint, which
 * is exactly how a 1.8x overshoot shipped unnoticed.
 */
const residentBytes = (partSize: number) => {
    const { windowSize, maxConcurrent } = deriveConcurrency(partSize);
    return (windowSize + maxConcurrent) * partSize;
};

describe('deriveConcurrency', () => {
    // The window used to be a part count (maxConcurrent + 2), so the OPFS
    // footprint silently tracked part size: ~1.6 GB at the old 200MB default.
    it.each([
        [64, 6, 4],
        [65, 5, 3],
        [96, 4, 2],
        [128, 3, 2],
    ])('should derive window/concurrency for %d MiB parts', (mib, window, concurrency) => {
        const result = deriveConcurrency(mib * MiB);
        expect(result.windowSize).toBe(window);
        expect(result.maxConcurrent).toBe(concurrency);
    });

    it('should keep RESIDENT bytes within the budget across every reachable part size', () => {
        // Every part size the backend can allocate is inside this range, so
        // the budget is binding in practice.
        expect(PART_SIZING.CEILING / MiB).toBeLessThanOrEqual(BUDGET_BINDS_UP_TO_MiB);
        for (let mib = 5; mib <= BUDGET_BINDS_UP_TO_MiB; mib++) {
            expect(residentBytes(mib * MiB), `${mib} MiB parts`).toBeLessThanOrEqual(BUDGET);
        }
    });

    it('should overshoot only marginally where the window floor outranks the budget', () => {
        // Reachable: the trailing-part correction pushes part size to 130 MiB.
        // Bounded overshoot beats a window too tight to stage into.
        for (let mib = BUDGET_BINDS_UP_TO_MiB + 1; mib <= 130; mib++) {
            expect(residentBytes(mib * MiB), `${mib} MiB parts`).toBeLessThanOrEqual(BUDGET * 1.02);
        }
    });

    it('should hold the window at its floor rather than the budget for absurd part sizes', () => {
        // Unreachable through PART_SIZING, and the floor is the right answer
        // anyway: a two-uploader pool needs a third slot to stage into.
        expect(deriveConcurrency(512 * MiB)).toEqual({ windowSize: 3, maxConcurrent: 2 });
    });

    it('should always leave the window wider than the uploader pool', () => {
        // A window at or below the pool size starves uploaders permanently.
        for (let mib = 5; mib <= 512; mib++) {
            const { windowSize, maxConcurrent } = deriveConcurrency(mib * MiB);
            expect(windowSize, `${mib} MiB parts`).toBeGreaterThan(maxConcurrent);
        }
    });
});

describe('isPushbackError', () => {
    it.each([
        'HTTP 429',
        'http 503 from bucket',
        'Request failed: HTTP 429',
    ])('should recognise %s as server pushback', (msg) => {
        expect(isPushbackError(new Error(msg))).toBe(true);
    });

    it.each([
        'HTTP 0',
        'network error',
        'HTTP 403 forbidden',
        'stalled',
        'HTTP 500',
    ])('should not treat %s as pushback', (msg) => {
        // 403 is URL expiry (one refresh), HTTP 0/network feed offline
        // inference, 500 is a retryable fault — none mean "slow down".
        expect(isPushbackError(new Error(msg))).toBe(false);
    });
});

describe('createConcurrencyController', () => {
    const opts = { initial: 4, min: 2, max: 8, probeIntervalMs: 10_000, cooldownMs: 60_000 };

    it('should start at the initial target, clamped to the range', () => {
        expect(createConcurrencyController(opts).target()).toBe(4);
        expect(createConcurrencyController({ ...opts, initial: 99 }).target()).toBe(8);
        expect(createConcurrencyController({ ...opts, initial: 0 }).target()).toBe(2);
    });

    it('should grow by one per probe interval while saturated', () => {
        const c = createConcurrencyController(opts);
        c.tick(0); // establishes the window origin, never grows
        expect(c.target()).toBe(4);
        expect(c.tick(10_000)).toBe(5);
        expect(c.tick(20_000)).toBe(6);
    });

    it('should not grow before a full probe interval has elapsed', () => {
        const c = createConcurrencyController(opts);
        c.tick(0);
        expect(c.tick(9_999)).toBe(4);
    });

    it('should not grow past max', () => {
        const c = createConcurrencyController({ ...opts, initial: 8 });
        c.tick(0);
        expect(c.tick(10_000)).toBe(8);
    });

    it('should not grow when a worker idled during the window', () => {
        // An idle worker means staging is the bottleneck, not the pool.
        const c = createConcurrencyController(opts);
        c.tick(0);
        c.onIdle();
        expect(c.tick(10_000)).toBe(4);
        // The idle flag is per-window: a clean next window may grow.
        expect(c.tick(20_000)).toBe(5);
    });

    it('should halve on pushback and floor at min', () => {
        const c = createConcurrencyController({ ...opts, initial: 8 });
        c.onPushback(1_000);
        expect(c.target()).toBe(4);
        c.onPushback(2_000);
        expect(c.target()).toBe(2);
        c.onPushback(3_000);
        expect(c.target()).toBe(2);
    });

    it('should suppress growth for the cooldown after pushback', () => {
        const c = createConcurrencyController(opts);
        c.tick(0);
        c.onPushback(1_000); // target 2, cooldown until 61_000
        expect(c.tick(11_000)).toBe(2);
        expect(c.tick(21_000)).toBe(2);
        expect(c.tick(61_000)).toBe(3); // cooldown expired
    });

    it('should measure by wall clock, not tick cadence', () => {
        // Worker timers get throttled or suspended; a tick that fires an hour
        // late must see one elapsed window, not sixty.
        const c = createConcurrencyController(opts);
        c.tick(0);
        expect(c.tick(3_600_000)).toBe(5);
    });

    it('should report peak and pushback count for telemetry', () => {
        const c = createConcurrencyController(opts);
        c.tick(0);
        c.tick(10_000);
        c.tick(20_000);
        expect(c.peak()).toBe(6);
        c.onPushback(21_000);
        expect(c.target()).toBe(3);
        expect(c.peak()).toBe(6);
        expect(c.pushbacks()).toBe(1);
    });
});
