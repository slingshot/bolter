import { describe, expect, it } from 'bun:test';
import {
    BYTES,
    DOWNLOAD_LIMITS,
    PART_SIZE_TIERS,
    TIME_LIMITS,
    UI_DEFAULTS,
    UPLOAD_LIMITS,
} from '../config';

describe('BYTES constants', () => {
    it('should define KB as 1000', () => {
        expect(BYTES.KB).toBe(1000);
    });

    it('should define MB as 1,000,000', () => {
        expect(BYTES.MB).toBe(1_000_000);
    });

    it('should define GB as 1,000,000,000', () => {
        expect(BYTES.GB).toBe(1_000_000_000);
    });

    it('should define TB as 1,000,000,000,000', () => {
        expect(BYTES.TB).toBe(1_000_000_000_000);
    });

    it('should use decimal (SI) prefixes, not binary', () => {
        expect(BYTES.KB).toBe(1000);
        expect(BYTES.MB).toBe(BYTES.KB * 1000);
        expect(BYTES.GB).toBe(BYTES.MB * 1000);
        expect(BYTES.TB).toBe(BYTES.GB * 1000);
    });
});

describe('UPLOAD_LIMITS', () => {
    it('should set MAX_FILE_SIZE to 1 TB', () => {
        expect(UPLOAD_LIMITS.MAX_FILE_SIZE).toBe(1 * BYTES.TB);
    });

    it('should set MULTIPART_THRESHOLD to 100 MB', () => {
        expect(UPLOAD_LIMITS.MULTIPART_THRESHOLD).toBe(100 * BYTES.MB);
    });

    it('should set DEFAULT_PART_SIZE to 200 MB', () => {
        expect(UPLOAD_LIMITS.DEFAULT_PART_SIZE).toBe(200 * BYTES.MB);
    });

    it('should set MAX_PART_SIZE to 5 GB', () => {
        expect(UPLOAD_LIMITS.MAX_PART_SIZE).toBe(5 * BYTES.GB);
    });

    it('should set MIN_PART_SIZE to 5 MB', () => {
        expect(UPLOAD_LIMITS.MIN_PART_SIZE).toBe(5 * BYTES.MB);
    });

    it('should set MAX_PARTS to 10000 (R2 limit)', () => {
        expect(UPLOAD_LIMITS.MAX_PARTS).toBe(10000);
    });

    it('should set MAX_FILES_PER_ARCHIVE to 64', () => {
        expect(UPLOAD_LIMITS.MAX_FILES_PER_ARCHIVE).toBe(64);
    });

    it('should allow MAX_FILE_SIZE to be divided into at most MAX_PARTS with MAX_PART_SIZE', () => {
        // MAX_FILE_SIZE / MAX_PART_SIZE should be <= MAX_PARTS
        // This guarantees any file up to MAX_FILE_SIZE can be uploaded with sufficiently large parts
        const partsNeeded = Math.ceil(UPLOAD_LIMITS.MAX_FILE_SIZE / UPLOAD_LIMITS.MAX_PART_SIZE);
        expect(partsNeeded).toBeLessThanOrEqual(UPLOAD_LIMITS.MAX_PARTS);
    });

    it('should have MAX_FILE_SIZE / DEFAULT_PART_SIZE within MAX_PARTS', () => {
        // The default part size should allow MAX_FILE_SIZE uploads without exceeding MAX_PARTS
        const partsNeeded = Math.ceil(
            UPLOAD_LIMITS.MAX_FILE_SIZE / UPLOAD_LIMITS.DEFAULT_PART_SIZE,
        );
        expect(partsNeeded).toBeLessThanOrEqual(UPLOAD_LIMITS.MAX_PARTS);
    });

    it('should have DEFAULT_PART_SIZE between MIN and MAX', () => {
        expect(UPLOAD_LIMITS.DEFAULT_PART_SIZE).toBeGreaterThanOrEqual(UPLOAD_LIMITS.MIN_PART_SIZE);
        expect(UPLOAD_LIMITS.DEFAULT_PART_SIZE).toBeLessThanOrEqual(UPLOAD_LIMITS.MAX_PART_SIZE);
    });

    it('should have MULTIPART_THRESHOLD less than MAX_FILE_SIZE', () => {
        expect(UPLOAD_LIMITS.MULTIPART_THRESHOLD).toBeLessThan(UPLOAD_LIMITS.MAX_FILE_SIZE);
    });
});

describe('PART_SIZE_TIERS', () => {
    it('should be sorted descending by minSpeed', () => {
        for (let i = 1; i < PART_SIZE_TIERS.length; i++) {
            expect(PART_SIZE_TIERS[i].minSpeed).toBeLessThan(PART_SIZE_TIERS[i - 1].minSpeed);
        }
    });

    it('should have the last tier with minSpeed = 0 (catch-all)', () => {
        const lastTier = PART_SIZE_TIERS[PART_SIZE_TIERS.length - 1];
        expect(lastTier.minSpeed).toBe(0);
    });

    it('should have all partSizes within MIN_PART_SIZE and MAX_PART_SIZE bounds', () => {
        for (const tier of PART_SIZE_TIERS) {
            expect(tier.partSize).toBeGreaterThanOrEqual(UPLOAD_LIMITS.MIN_PART_SIZE);
            expect(tier.partSize).toBeLessThanOrEqual(UPLOAD_LIMITS.MAX_PART_SIZE);
        }
    });

    it('should have partSizes sorted descending (faster speed = larger parts)', () => {
        for (let i = 1; i < PART_SIZE_TIERS.length; i++) {
            expect(PART_SIZE_TIERS[i].partSize).toBeLessThanOrEqual(
                PART_SIZE_TIERS[i - 1].partSize,
            );
        }
    });

    it('should have exactly 4 tiers', () => {
        expect(PART_SIZE_TIERS).toHaveLength(4);
    });

    it('should have the fastest tier at 200 MB partSize', () => {
        expect(PART_SIZE_TIERS[0].partSize).toBe(200 * BYTES.MB);
    });

    it('should have the slowest tier at 25 MB partSize', () => {
        expect(PART_SIZE_TIERS[PART_SIZE_TIERS.length - 1].partSize).toBe(25 * BYTES.MB);
    });
});

describe('TIME_LIMITS', () => {
    it('should set MAX_EXPIRE_SECONDS to 6 months (180 days)', () => {
        expect(TIME_LIMITS.MAX_EXPIRE_SECONDS).toBe(86400 * 180);
    });

    it('should set DEFAULT_EXPIRE_SECONDS to 1 day', () => {
        expect(TIME_LIMITS.DEFAULT_EXPIRE_SECONDS).toBe(86400);
    });

    it('should have EXPIRE_TIMES sorted ascending', () => {
        for (let i = 1; i < TIME_LIMITS.EXPIRE_TIMES.length; i++) {
            expect(TIME_LIMITS.EXPIRE_TIMES[i]).toBeGreaterThan(TIME_LIMITS.EXPIRE_TIMES[i - 1]);
        }
    });

    it('should have all EXPIRE_TIMES within MAX_EXPIRE_SECONDS', () => {
        for (const time of TIME_LIMITS.EXPIRE_TIMES) {
            expect(time).toBeLessThanOrEqual(TIME_LIMITS.MAX_EXPIRE_SECONDS);
        }
    });

    it('should include DEFAULT_EXPIRE_SECONDS in EXPIRE_TIMES', () => {
        expect(TIME_LIMITS.EXPIRE_TIMES).toContain(TIME_LIMITS.DEFAULT_EXPIRE_SECONDS);
    });

    it('should have the shortest expire time as 5 minutes (300s)', () => {
        expect(TIME_LIMITS.EXPIRE_TIMES[0]).toBe(300);
    });

    it('should have the longest expire time as 6 months (15552000s)', () => {
        expect(TIME_LIMITS.EXPIRE_TIMES[TIME_LIMITS.EXPIRE_TIMES.length - 1]).toBe(15552000);
    });
});

describe('DOWNLOAD_LIMITS', () => {
    it('should set MAX_DOWNLOADS to 100', () => {
        expect(DOWNLOAD_LIMITS.MAX_DOWNLOADS).toBe(100);
    });

    it('should set DEFAULT_DOWNLOADS to 1', () => {
        expect(DOWNLOAD_LIMITS.DEFAULT_DOWNLOADS).toBe(1);
    });

    it('should have DOWNLOAD_COUNTS sorted ascending', () => {
        for (let i = 1; i < DOWNLOAD_LIMITS.DOWNLOAD_COUNTS.length; i++) {
            expect(DOWNLOAD_LIMITS.DOWNLOAD_COUNTS[i]).toBeGreaterThan(
                DOWNLOAD_LIMITS.DOWNLOAD_COUNTS[i - 1],
            );
        }
    });

    it('should have all DOWNLOAD_COUNTS within MAX_DOWNLOADS', () => {
        for (const count of DOWNLOAD_LIMITS.DOWNLOAD_COUNTS) {
            expect(count).toBeLessThanOrEqual(DOWNLOAD_LIMITS.MAX_DOWNLOADS);
        }
    });

    it('should include DEFAULT_DOWNLOADS in DOWNLOAD_COUNTS', () => {
        expect(DOWNLOAD_LIMITS.DOWNLOAD_COUNTS).toContain(DOWNLOAD_LIMITS.DEFAULT_DOWNLOADS);
    });

    it('should include MAX_DOWNLOADS in DOWNLOAD_COUNTS', () => {
        expect(DOWNLOAD_LIMITS.DOWNLOAD_COUNTS).toContain(DOWNLOAD_LIMITS.MAX_DOWNLOADS);
    });
});

describe('UI_DEFAULTS', () => {
    it('should set TITLE to "Slingshot Send"', () => {
        expect(UI_DEFAULTS.TITLE).toBe('Slingshot Send');
    });

    it('should have a non-empty DESCRIPTION', () => {
        expect(UI_DEFAULTS.DESCRIPTION).toBeTruthy();
        expect(typeof UI_DEFAULTS.DESCRIPTION).toBe('string');
        expect(UI_DEFAULTS.DESCRIPTION.length).toBeGreaterThan(0);
    });
});
