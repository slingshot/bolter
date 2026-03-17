import { describe, expect, test } from 'bun:test';
import { formatBytes, formatDuration, formatSpeed, parseDuration } from '../lib/format';

describe('formatBytes', () => {
    test('returns "0 B" for zero bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
    });

    test('formats bytes below 1 KB', () => {
        expect(formatBytes(500)).toBe('500 B');
    });

    test('formats exactly 1 KB (1000 bytes)', () => {
        expect(formatBytes(1000)).toBe('1.00 KB');
    });

    test('formats fractional KB', () => {
        expect(formatBytes(1500)).toBe('1.50 KB');
    });

    test('formats 1 MB', () => {
        expect(formatBytes(1_000_000)).toBe('1.00 MB');
    });

    test('formats 1.5 MB', () => {
        expect(formatBytes(1_500_000)).toBe('1.50 MB');
    });

    test('formats 1 GB', () => {
        expect(formatBytes(1_000_000_000)).toBe('1.00 GB');
    });

    test('formats 1 TB', () => {
        expect(formatBytes(1_000_000_000_000)).toBe('1.00 TB');
    });

    test('formats values >= 100 as integers (no decimals)', () => {
        // 500 KB = 500_000 bytes → value is 500, should be integer
        expect(formatBytes(500_000)).toBe('500 KB');
    });

    test('formats values >= 10 with one decimal', () => {
        // 10.5 KB = 10_500 bytes
        expect(formatBytes(10_500)).toBe('10.5 KB');
    });

    test('formats values < 10 with two decimals', () => {
        // 5.25 KB = 5_250 bytes
        expect(formatBytes(5250)).toBe('5.25 KB');
    });

    test('formats very large values (petabyte range) beyond units array', () => {
        // 1 PB = 1e15, index would be 5 which is beyond the units array ['B','KB','MB','GB','TB']
        // The function doesn't clamp, so unit becomes undefined
        const result = formatBytes(1_000_000_000_000_000);
        expect(result).toBe('1.00 undefined');
    });

    test('formats single byte', () => {
        expect(formatBytes(1)).toBe('1.00 B');
    });
});

describe('formatDuration', () => {
    test('returns "<1s" for sub-second durations', () => {
        expect(formatDuration(0.5)).toBe('<1s');
    });

    test('returns "<1s" for zero seconds', () => {
        expect(formatDuration(0)).toBe('<1s');
    });

    test('formats seconds only', () => {
        expect(formatDuration(5)).toBe('5s');
    });

    test('formats exactly 1 second', () => {
        expect(formatDuration(1)).toBe('1s');
    });

    test('rounds fractional seconds in the seconds range', () => {
        expect(formatDuration(59.4)).toBe('59s');
    });

    test('formats minutes and seconds', () => {
        expect(formatDuration(90)).toBe('1m 30s');
    });

    test('formats minutes only when no remaining seconds', () => {
        expect(formatDuration(120)).toBe('2m');
    });

    test('formats hours and minutes', () => {
        expect(formatDuration(8100)).toBe('2h 15m');
    });

    test('formats hours only when no remaining minutes', () => {
        expect(formatDuration(3600)).toBe('1h');
    });

    test('formats days only', () => {
        expect(formatDuration(86400)).toBe('1d');
    });

    test('formats days and hours', () => {
        expect(formatDuration(7 * 86400 + 12 * 3600)).toBe('7d 12h');
    });

    test('formats large day counts', () => {
        expect(formatDuration(30 * 86400)).toBe('30d');
    });
});

describe('parseDuration', () => {
    test('parses "5m" to 300 seconds', () => {
        expect(parseDuration('5m')).toBe(300);
    });

    test('parses "1h" to 3600 seconds', () => {
        expect(parseDuration('1h')).toBe(3600);
    });

    test('parses "1d" to 86400 seconds', () => {
        expect(parseDuration('1d')).toBe(86400);
    });

    test('parses "7d" to 604800 seconds', () => {
        expect(parseDuration('7d')).toBe(604800);
    });

    test('parses "14d" from alias map', () => {
        expect(parseDuration('14d')).toBe(1209600);
    });

    test('parses "30d" from alias map', () => {
        expect(parseDuration('30d')).toBe(2592000);
    });

    test('parses "3mo" to 7776000 seconds', () => {
        expect(parseDuration('3mo')).toBe(7776000);
    });

    test('parses "6mo" to 15552000 seconds', () => {
        expect(parseDuration('6mo')).toBe(15552000);
    });

    test('parses generic minutes "10m" to 600 seconds', () => {
        expect(parseDuration('10m')).toBe(600);
    });

    test('parses generic hours "2h" to 7200 seconds', () => {
        expect(parseDuration('2h')).toBe(7200);
    });

    test('parses generic days "3d" to 259200 seconds', () => {
        expect(parseDuration('3d')).toBe(259200);
    });

    test('parses seconds "30s" to 30', () => {
        expect(parseDuration('30s')).toBe(30);
    });

    test('parses generic months "12mo" to 12 * 30 * 86400', () => {
        expect(parseDuration('12mo')).toBe(12 * 30 * 86400);
    });

    test('is case-insensitive', () => {
        expect(parseDuration('5M')).toBe(300);
        expect(parseDuration('1H')).toBe(3600);
        expect(parseDuration('1D')).toBe(86400);
    });

    test('trims whitespace', () => {
        expect(parseDuration('  5m  ')).toBe(300);
    });

    test('returns null for invalid strings', () => {
        expect(parseDuration('abc')).toBeNull();
        expect(parseDuration('')).toBeNull();
        expect(parseDuration('5x')).toBeNull();
        expect(parseDuration('hello world')).toBeNull();
    });

    test('returns null for unsupported unit combinations', () => {
        expect(parseDuration('5y')).toBeNull();
        expect(parseDuration('2w')).toBeNull();
    });
});

describe('formatSpeed', () => {
    test('appends "/s" to formatted bytes', () => {
        expect(formatSpeed(1000)).toBe('1.00 KB/s');
    });

    test('formats zero speed', () => {
        expect(formatSpeed(0)).toBe('0 B/s');
    });

    test('formats MB/s speed', () => {
        expect(formatSpeed(5_000_000)).toBe('5.00 MB/s');
    });

    test('formats GB/s speed', () => {
        expect(formatSpeed(1_000_000_000)).toBe('1.00 GB/s');
    });

    test('formats sub-KB speed', () => {
        expect(formatSpeed(500)).toBe('500 B/s');
    });
});
