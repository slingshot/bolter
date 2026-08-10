import { describe, expect, it } from 'bun:test';
import { config } from '../config';
import { clampDownloadLimit } from '../lib/download-limit';

describe('clampDownloadLimit (#5)', () => {
    it('passes through an in-range positive integer', () => {
        expect(clampDownloadLimit(5)).toBe(5);
    });

    it('clamps an over-max limit down to config.maxDownloads', () => {
        expect(clampDownloadLimit(1_000_000_000)).toBe(config.maxDownloads);
    });

    it('clamps zero and negative limits up to 1 so a file is never insta-bricked', () => {
        expect(clampDownloadLimit(0)).toBe(1);
        expect(clampDownloadLimit(-1)).toBe(1);
        expect(clampDownloadLimit(-1_000_000)).toBe(1);
    });

    it('truncates fractional limits to an integer', () => {
        expect(clampDownloadLimit(3.9)).toBe(3);
        expect(clampDownloadLimit(0.5)).toBe(1);
    });

    it('never produces a value that round-trips through Redis as exponential notation', () => {
        // `String(1e21)` is '1e+21', which parseInt reads back as 1 — a
        // single-use self-destruct. Clamping keeps the stored form decimal.
        const stored = String(clampDownloadLimit(1e21));
        expect(stored).not.toContain('e');
        expect(parseInt(stored, 10)).toBe(clampDownloadLimit(1e21));
    });

    it('falls back to the configured default for non-finite input', () => {
        expect(clampDownloadLimit(Number.NaN)).toBe(config.defaultDownloads);
        expect(clampDownloadLimit(Number.POSITIVE_INFINITY)).toBe(config.defaultDownloads);
    });

    it('is idempotent', () => {
        for (const value of [-5, 0, 1, 7, 1e12]) {
            expect(clampDownloadLimit(clampDownloadLimit(value))).toBe(clampDownloadLimit(value));
        }
    });
});
