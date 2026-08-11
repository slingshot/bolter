import { PART_SIZING } from '@bolter/shared';
import { describe, expect, it } from 'vitest';
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
