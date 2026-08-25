import { describe, expect, it } from 'bun:test';
import { validatePartSequence } from '../src/parts';

/** A legal effective part size: exactly the S3/R2 5 MiB minimum. */
const EFFECTIVE = 5_242_880;

describe('validatePartSequence', () => {
    it('throws on a gap in part numbers', () => {
        expect(() =>
            validatePartSequence(
                [
                    { partNumber: 1, size: EFFECTIVE },
                    { partNumber: 3, size: 10 },
                ],
                EFFECTIVE,
            ),
        ).toThrow(/^part sequence invalid/);
    });

    it('throws on a duplicate part number', () => {
        expect(() =>
            validatePartSequence(
                [
                    { partNumber: 1, size: EFFECTIVE },
                    { partNumber: 1, size: EFFECTIVE },
                    { partNumber: 2, size: 10 },
                ],
                EFFECTIVE,
            ),
        ).toThrow(/^part sequence invalid/);
    });

    it('throws when a non-trailing part is not exactly the effective size', () => {
        expect(() =>
            validatePartSequence(
                [
                    { partNumber: 1, size: EFFECTIVE - 1 },
                    { partNumber: 2, size: 10 },
                ],
                EFFECTIVE,
            ),
        ).toThrow(/^part sequence invalid/);
    });

    it('throws when a non-trailing part is below the 5 MiB S3/R2 minimum', () => {
        // Matches the effective size, but the effective size itself is illegal
        // for non-trailing parts.
        expect(() =>
            validatePartSequence(
                [
                    { partNumber: 1, size: 4_000_000 },
                    { partNumber: 2, size: 10 },
                ],
                4_000_000,
            ),
        ).toThrow(/^part sequence invalid/);
    });

    it('throws on an empty part list', () => {
        expect(() => validatePartSequence([], EFFECTIVE)).toThrow(/^part sequence invalid/);
    });

    it('throws on an empty trailing part', () => {
        expect(() =>
            validatePartSequence(
                [
                    { partNumber: 1, size: EFFECTIVE },
                    { partNumber: 2, size: 0 },
                ],
                EFFECTIVE,
            ),
        ).toThrow(/^part sequence invalid/);
    });

    it('accepts an oversized trailing part (growth absorption)', () => {
        expect(() =>
            validatePartSequence(
                [
                    { partNumber: 1, size: EFFECTIVE },
                    { partNumber: 2, size: EFFECTIVE + 123 },
                ],
                EFFECTIVE,
            ),
        ).not.toThrow();
    });

    it('accepts a single small part', () => {
        expect(() => validatePartSequence([{ partNumber: 1, size: 3 }], EFFECTIVE)).not.toThrow();
    });

    it('accepts parts given out of order', () => {
        expect(() =>
            validatePartSequence(
                [
                    { partNumber: 2, size: 10 },
                    { partNumber: 1, size: EFFECTIVE },
                ],
                EFFECTIVE,
            ),
        ).not.toThrow();
    });
});
