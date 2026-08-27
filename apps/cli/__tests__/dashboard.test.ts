import { describe, expect, it } from 'bun:test';
import {
    DASHBOARD_ROWS,
    MIN_ROWS,
    type PromotionInput,
    partsBar,
    shouldPromote,
    sparkline,
} from '../src/ui/dashboard';

const base: PromotionInput = {
    stdoutIsTTY: true,
    stderrIsTTY: true,
    columns: 120,
    rows: 40,
    json: false,
    env: {},
    totalBytes: 500_000_000,
    threshold: 100_000_000,
};

/**
 * Taking over someone's terminal is the most intrusive thing this CLI does, so
 * the conditions under which it happens are worth pinning precisely.
 */
describe('promotion', () => {
    it('promotes a large transfer in a roomy terminal', () => {
        expect(shouldPromote(base)).toBe(true);
    });

    it('does not promote a brief transfer', () => {
        // Alt-screen output for a two-second upload clears the terminal, draws,
        // and hands it back — strictly worse than one line.
        expect(shouldPromote({ ...base, totalBytes: 1_000_000 })).toBe(false);
    });

    it('never promotes when output is piped', () => {
        expect(shouldPromote({ ...base, stdoutIsTTY: false })).toBe(false);
        expect(shouldPromote({ ...base, stderrIsTTY: false })).toBe(false);
    });

    it('never promotes under --json, whatever else is true', () => {
        // stdout has to stay a single parseable object.
        expect(shouldPromote({ ...base, json: true, force: true })).toBe(false);
    });

    it('never promotes in CI or a dumb terminal', () => {
        expect(shouldPromote({ ...base, env: { CI: 'true' } })).toBe(false);
        expect(shouldPromote({ ...base, env: { TERM: 'dumb' } })).toBe(false);
    });

    it('does not promote into a terminal too small for the layout', () => {
        expect(shouldPromote({ ...base, columns: 40 })).toBe(false);
        expect(shouldPromote({ ...base, rows: 8 })).toBe(false);
    });

    /**
     * The bug this pins: the old layout drew ~28 rows while promotion admitted
     * 15-row terminals, so the panels painted over each other and over their
     * own borders. Nothing about that needed a resize — it reproduced on a
     * plain 100x20 terminal, first frame. Any terminal that cannot seat the
     * whole frame must therefore be refused, and the threshold has to be
     * derived from the layout rather than guessed alongside it.
     */
    it('refuses any terminal that cannot seat the frame it would draw', () => {
        // The gate is derived from the frame, not guessed next to it.
        expect(MIN_ROWS).toBeGreaterThan(DASHBOARD_ROWS);
        expect(shouldPromote({ ...base, rows: MIN_ROWS - 1 })).toBe(false);
        expect(shouldPromote({ ...base, rows: MIN_ROWS })).toBe(true);
    });

    it('refuses a short terminal even when --tui asks for it', () => {
        // Forcing cannot make the rows exist.
        expect(shouldPromote({ ...base, force: true, rows: MIN_ROWS - 1 })).toBe(false);
    });

    it('lets --tui and --no-tui override the size heuristic', () => {
        expect(shouldPromote({ ...base, totalBytes: 1000, force: true })).toBe(true);
        expect(shouldPromote({ ...base, force: false })).toBe(false);
    });

    it('still refuses a forced dashboard where it cannot draw', () => {
        expect(shouldPromote({ ...base, force: true, stdoutIsTTY: false })).toBe(false);
        expect(shouldPromote({ ...base, force: true, columns: 20 })).toBe(false);
    });
});

describe('sparkline', () => {
    it('is exactly the requested width', () => {
        expect(sparkline([1, 2, 3], 10)).toHaveLength(10);
        expect(sparkline([], 10)).toHaveLength(10);
    });

    it('scales to its own peak, so a slow link still shows shape', () => {
        // Absolute scaling would render every sample from a 1 MB/s link as the
        // same flat bottom row.
        const slow = sparkline([100, 200, 300, 400], 4);
        const fast = sparkline([100_000, 200_000, 300_000, 400_000], 4);
        expect(slow).toBe(fast);
    });

    it('shows the most recent samples when there are more than fit', () => {
        expect(sparkline([8, 8, 8, 1], 2)).toBe(sparkline([8, 1], 2));
    });
});

describe('partsBar', () => {
    it('is exactly the requested width at any scale', () => {
        for (const total of [1, 3, 630, 7451]) {
            expect(partsBar(1, 1, total, 30)).toHaveLength(30);
        }
    });

    it('fills completely when everything is done', () => {
        expect(partsBar(10, 0, 10, 10)).toBe('█'.repeat(10));
    });

    it('shows in-flight parts even when they round to nothing', () => {
        // At 7,451 parts one in flight is 0.01% of the bar; rounding it away
        // would make an active transfer look idle.
        expect(partsBar(0, 1, 7451, 40)).toContain('▒');
    });

    it('handles an unknown part count without dividing by zero', () => {
        expect(partsBar(0, 0, 0, 8)).toBe('░'.repeat(8));
    });
});
