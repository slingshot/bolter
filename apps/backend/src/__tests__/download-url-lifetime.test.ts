import { describe, expect, it } from 'bun:test';
import {
    DIRECT_URL_FLOOR_THROUGHPUT_BPS,
    DIRECT_URL_MARGIN_SECONDS,
    DIRECT_URL_MAX_LIFETIME_SECONDS,
    DIRECT_URL_MIN_LIFETIME_SECONDS,
    directDownloadUrlLifetime,
} from '../lib/download-url-lifetime';

const GiB = 1024 ** 3;

describe('directDownloadUrlLifetime', () => {
    it('never signs for less than the minimum, whatever the size says', () => {
        for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1]) {
            expect(directDownloadUrlLifetime(size)).toBeGreaterThanOrEqual(
                DIRECT_URL_MIN_LIFETIME_SECONDS,
            );
        }
        expect(directDownloadUrlLifetime(0)).toBe(DIRECT_URL_MIN_LIFETIME_SECONDS);
    });

    it('covers a full transfer at the floor throughput plus the margin', () => {
        // The 37 GB download from BOLTER-FRONTEND-64 needs ~41 h at the floor
        // rate; the old flat hour left a browser-side resume with a 403.
        const size = 37 * GiB;
        const expected =
            Math.ceil(size / DIRECT_URL_FLOOR_THROUGHPUT_BPS) + DIRECT_URL_MARGIN_SECONDS;
        expect(directDownloadUrlLifetime(size)).toBe(expected);
        expect(expected).toBeGreaterThan(24 * 3600);
    });

    it('caps at the SigV4 ceiling of seven days', () => {
        expect(directDownloadUrlLifetime(1024 * GiB)).toBe(DIRECT_URL_MAX_LIFETIME_SECONDS);
        expect(DIRECT_URL_MAX_LIFETIME_SECONDS).toBe(7 * 24 * 3600);
    });

    it('is monotonic in file size and always a whole number of seconds', () => {
        let previous = 0;
        for (const size of [1, 1e6, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13]) {
            const lifetime = directDownloadUrlLifetime(size);
            expect(Number.isInteger(lifetime)).toBe(true);
            expect(lifetime).toBeGreaterThanOrEqual(previous);
            previous = lifetime;
        }
    });
});
