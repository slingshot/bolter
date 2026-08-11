import { PART_SIZING } from '@bolter/shared';
import { describe, expect, it } from 'vitest';
import { deriveConcurrency } from '../engine';

const MiB = 1024 * 1024;

/**
 * Largest part size the 640 MiB budget can actually hold: at 214 MiB the
 * MIN_WINDOW floor of 3 parts already exceeds it. The floor deliberately
 * outranks the budget there — a window that cannot stage ahead of the
 * uploader pool starves it — and allocation never reaches that size.
 */
const BUDGET_BINDS_UP_TO_MiB = 213;

describe('deriveConcurrency', () => {
    // The window used to be a part count (maxConcurrent + 2), so the OPFS
    // footprint silently tracked part size: ~1 GB at the old 200MB default.
    it.each([
        [64, 10, 8],
        [65, 9, 7],
        [96, 6, 4],
        [128, 5, 3],
    ])('should derive window/concurrency for %d MiB parts', (mib, window, concurrency) => {
        const result = deriveConcurrency(mib * MiB);
        expect(result.windowSize).toBe(window);
        expect(result.maxConcurrent).toBe(concurrency);
    });

    it('should keep staged bytes within the budget across every reachable part size', () => {
        // Every part size the backend can allocate is inside this range, so
        // the budget is binding in practice.
        expect(PART_SIZING.CEILING / MiB).toBeLessThanOrEqual(BUDGET_BINDS_UP_TO_MiB);
        for (let mib = 5; mib <= BUDGET_BINDS_UP_TO_MiB; mib++) {
            const { windowSize } = deriveConcurrency(mib * MiB);
            expect(windowSize * mib * MiB, `${mib} MiB parts`).toBeLessThanOrEqual(640 * MiB);
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
