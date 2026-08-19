import { describe, expect, it } from 'bun:test';
import { createConcurrencyController, isPushbackError } from '../src/concurrency';

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
