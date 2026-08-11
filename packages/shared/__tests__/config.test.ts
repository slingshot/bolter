import { describe, expect, it } from 'bun:test';
import {
    BYTES,
    DOWNLOAD_LIMITS,
    PART_SIZING,
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

    it('should set MAX_PART_SIZE to 5 GB', () => {
        expect(UPLOAD_LIMITS.MAX_PART_SIZE).toBe(5 * BYTES.GB);
    });

    it('should set MIN_PART_SIZE to 5 MiB (S3/R2 enforce MiB, not decimal MB)', () => {
        expect(UPLOAD_LIMITS.MIN_PART_SIZE).toBe(5 * 1024 * 1024);
    });

    it('should set MAX_PARTS to 10000 (R2 limit)', () => {
        expect(UPLOAD_LIMITS.MAX_PARTS).toBe(10000);
    });

    it('should set MAX_FILES_PER_ARCHIVE to 1000', () => {
        expect(UPLOAD_LIMITS.MAX_FILES_PER_ARCHIVE).toBe(1000);
    });

    it('should allow MAX_FILE_SIZE to be divided into at most MAX_PARTS with MAX_PART_SIZE', () => {
        // MAX_FILE_SIZE / MAX_PART_SIZE should be <= MAX_PARTS
        // This guarantees any file up to MAX_FILE_SIZE can be uploaded with sufficiently large parts
        const partsNeeded = Math.ceil(UPLOAD_LIMITS.MAX_FILE_SIZE / UPLOAD_LIMITS.MAX_PART_SIZE);
        expect(partsNeeded).toBeLessThanOrEqual(UPLOAD_LIMITS.MAX_PARTS);
    });

    it('should have MULTIPART_THRESHOLD less than MAX_FILE_SIZE', () => {
        expect(UPLOAD_LIMITS.MULTIPART_THRESHOLD).toBeLessThan(UPLOAD_LIMITS.MAX_FILE_SIZE);
    });
});

describe('PART_SIZING', () => {
    it('should keep the worst case inside R2 MAX_PARTS', () => {
        // The ceiling is the only thing standing between a 1TB upload and the
        // 10,000-part limit.
        expect(UPLOAD_LIMITS.MAX_FILE_SIZE / PART_SIZING.CEILING).toBeLessThan(
            UPLOAD_LIMITS.MAX_PARTS,
        );
    });

    it('should keep both bounds inside R2 part-size limits', () => {
        expect(PART_SIZING.FLOOR).toBeGreaterThanOrEqual(UPLOAD_LIMITS.MIN_PART_SIZE);
        expect(PART_SIZING.CEILING).toBeLessThanOrEqual(UPLOAD_LIMITS.MAX_PART_SIZE);
        expect(PART_SIZING.FLOOR).toBeLessThanOrEqual(PART_SIZING.CEILING);
    });

    it('should keep the write rate against one key at or below ~1.5/sec on a fast link', () => {
        // writes/sec against a key = throughput / partSize, independent of
        // concurrency. R2 documents 1 write/sec/key; whether that covers
        // UploadPart is unstated, so the floor buys headroom.
        const fastLinkBytesPerSecond = 100_000_000;
        expect(fastLinkBytesPerSecond / PART_SIZING.FLOOR).toBeLessThan(1.6);
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
