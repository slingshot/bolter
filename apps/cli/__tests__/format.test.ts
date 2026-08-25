import { describe, expect, it } from 'bun:test';
import {
    formatBytes,
    formatDuration,
    formatExpiry,
    formatRate,
    keyValueLines,
    progressBar,
    truncateMiddle,
} from '../src/ui/format';

describe('formatBytes', () => {
    it('uses decimal units, matching what the server reports', () => {
        // The API expresses every limit in decimal units. Showing 1 GB as
        // 0.93 GiB against a 1 GB cap reads like a bug.
        expect(formatBytes(1_000)).toBe('1.0 KB');
        expect(formatBytes(1_000_000)).toBe('1.0 MB');
        expect(formatBytes(1_000_000_000_000)).toBe('1.0 TB');
    });

    it('keeps bytes whole', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(999)).toBe('999 B');
    });

    it('does not invent precision for a nonsense size', () => {
        expect(formatBytes(Number.NaN)).toBe('—');
        expect(formatBytes(-1)).toBe('—');
    });
});

describe('formatRate', () => {
    it('renders a throughput', () => {
        expect(formatRate(118_000_000)).toBe('118 MB/s');
    });

    it('shows nothing rather than 0 B/s before the first sample', () => {
        expect(formatRate(0)).toBe('—');
    });
});

describe('formatDuration', () => {
    it.each([
        [5, '5s'],
        [61, '1m 1s'],
        [120, '2m'],
        [3_600, '1h'],
        [3_900, '1h 5m'],
        [86_400, '1d'],
        [90_000, '1d 1h'],
    ])('%i seconds is %s', (seconds, expected) => {
        expect(formatDuration(seconds)).toBe(expected);
    });
});

describe('formatExpiry', () => {
    it('says expired rather than a negative duration', () => {
        expect(formatExpiry(0)).toBe('expired');
        expect(formatExpiry(-5)).toBe('expired');
    });

    it('reads as a sentence fragment', () => {
        expect(formatExpiry(3_900)).toBe('in 1h 5m');
    });
});

describe('progressBar', () => {
    it('fills and empties completely at the extremes', () => {
        expect(progressBar(0, 10)).toBe('░'.repeat(10));
        expect(progressBar(1, 10)).toBe('█'.repeat(10));
    });

    it('is always exactly the requested width', () => {
        for (const f of [0, 0.01, 0.333, 0.5, 0.999, 1]) {
            expect(progressBar(f, 24)).toHaveLength(24);
        }
    });

    it('shows movement below one whole cell', () => {
        // At 40 cells a whole cell is 2.5%; without partial blocks a long
        // transfer looks frozen for minutes at a time.
        expect(progressBar(0.01, 40)).not.toBe('░'.repeat(40));
    });

    it('clamps rather than overflowing on a bad fraction', () => {
        expect(progressBar(2, 8)).toBe('█'.repeat(8));
        expect(progressBar(Number.NaN, 8)).toBe('░'.repeat(8));
    });
});

describe('keyValueLines', () => {
    it('aligns values on the longest key', () => {
        expect(
            keyValueLines([
                ['id', 'abc'],
                ['downloads', '1 of 3'],
            ]),
        ).toEqual(['id         abc', 'downloads  1 of 3']);
    });
});

describe('truncateMiddle', () => {
    it('keeps both ends of a long name', () => {
        const result = truncateMiddle('a-very-long-archive-name.tar.zst', 16);
        expect(result).toHaveLength(16);
        expect(result.startsWith('a-very-')).toBe(true);
        expect(result.endsWith('.zst')).toBe(true);
    });

    it('leaves a short name alone', () => {
        expect(truncateMiddle('notes.pdf', 20)).toBe('notes.pdf');
    });
});
