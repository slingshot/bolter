import { describe, expect, it } from 'vitest';
import {
    formatBytes,
    formatDownloadLimit,
    formatDuration,
    formatSpeed,
    formatTimeLimit,
    getFileExtension,
    getFileIcon,
} from '@/lib/utils';

describe('formatBytes', () => {
    it('formats 0 bytes', () => {
        expect(formatBytes(0)).toBe('0 Bytes');
    });

    it('formats bytes (< 1000)', () => {
        expect(formatBytes(500)).toBe('500 Bytes');
    });

    it('formats kilobytes', () => {
        expect(formatBytes(1000)).toBe('1 KB');
    });

    it('formats megabytes with decimals', () => {
        expect(formatBytes(1_500_000)).toBe('1.5 MB');
    });

    it('formats gigabytes', () => {
        expect(formatBytes(1_000_000_000)).toBe('1 GB');
    });

    it('formats terabytes', () => {
        expect(formatBytes(1_000_000_000_000)).toBe('1 TB');
    });

    it('respects custom decimal places', () => {
        expect(formatBytes(1_234_567, 0)).toBe('1 MB');
        expect(formatBytes(1_234_567, 1)).toBe('1.2 MB');
        expect(formatBytes(1_234_567, 3)).toBe('1.235 MB');
    });

    it('clamps negative decimals to 0', () => {
        expect(formatBytes(1_500_000, -1)).toBe('2 MB');
    });

    it('formats 1 byte', () => {
        expect(formatBytes(1)).toBe('1 Bytes');
    });

    it('formats exactly 1 KB boundary', () => {
        // Uses k=1000, so 1024 bytes is slightly over 1 KB
        expect(formatBytes(1000, 0)).toBe('1 KB');
    });
});

describe('formatDuration', () => {
    it('formats seconds (< 60)', () => {
        expect(formatDuration(30)).toBe('30s');
    });

    it('rounds fractional seconds', () => {
        expect(formatDuration(30.7)).toBe('31s');
    });

    it('formats minutes (60-3599)', () => {
        expect(formatDuration(90)).toBe('2m');
    });

    it('formats exactly 60 seconds as 1m', () => {
        expect(formatDuration(60)).toBe('1m');
    });

    it('formats hours (3600-86399)', () => {
        expect(formatDuration(7200)).toBe('2h');
    });

    it('formats exactly 1 hour', () => {
        expect(formatDuration(3600)).toBe('1h');
    });

    it('formats days (>= 86400)', () => {
        expect(formatDuration(172800)).toBe('2d');
    });

    it('formats exactly 1 day', () => {
        expect(formatDuration(86400)).toBe('1d');
    });

    it('formats 0 seconds', () => {
        expect(formatDuration(0)).toBe('0s');
    });
});

describe('formatTimeLimit', () => {
    it('formats 1 second (singular)', () => {
        expect(formatTimeLimit(1)).toBe('1 second');
    });

    it('formats multiple seconds (plural)', () => {
        expect(formatTimeLimit(30)).toBe('30 seconds');
    });

    it('formats 1 minute', () => {
        expect(formatTimeLimit(60)).toBe('1 minute');
    });

    it('formats multiple minutes', () => {
        expect(formatTimeLimit(300)).toBe('5 minutes');
    });

    it('formats 1 hour', () => {
        expect(formatTimeLimit(3600)).toBe('1 hour');
    });

    it('formats multiple hours', () => {
        expect(formatTimeLimit(7200)).toBe('2 hours');
    });

    it('formats 1 day', () => {
        expect(formatTimeLimit(86400)).toBe('1 day');
    });

    it('formats multiple days', () => {
        expect(formatTimeLimit(172800)).toBe('2 days');
    });

    it('formats 1 month (30 days)', () => {
        expect(formatTimeLimit(86400 * 30)).toBe('1 month');
    });

    it('formats multiple months', () => {
        expect(formatTimeLimit(86400 * 60)).toBe('2 months');
    });

    it('boundary: 59 seconds stays in seconds', () => {
        expect(formatTimeLimit(59)).toBe('59 seconds');
    });

    it('boundary: 3599 seconds stays in minutes', () => {
        expect(formatTimeLimit(3599)).toBe('60 minutes');
    });
});

describe('formatDownloadLimit', () => {
    it('formats singular download', () => {
        expect(formatDownloadLimit(1)).toBe('1 download');
    });

    it('formats plural downloads', () => {
        expect(formatDownloadLimit(5)).toBe('5 downloads');
    });

    it('formats zero downloads', () => {
        expect(formatDownloadLimit(0)).toBe('0 downloads');
    });

    it('formats large numbers', () => {
        expect(formatDownloadLimit(100)).toBe('100 downloads');
    });
});

describe('formatSpeed', () => {
    it('formats bytes per second', () => {
        expect(formatSpeed(500)).toBe('500 Bytes/s');
    });

    it('formats kilobytes per second', () => {
        expect(formatSpeed(1000)).toBe('1 KB/s');
    });

    it('formats megabytes per second', () => {
        expect(formatSpeed(1_000_000)).toBe('1 MB/s');
    });

    it('formats gigabytes per second', () => {
        expect(formatSpeed(1_000_000_000)).toBe('1 GB/s');
    });

    it('formats with 1 decimal place', () => {
        expect(formatSpeed(1_500_000)).toBe('1.5 MB/s');
    });

    it('formats zero', () => {
        expect(formatSpeed(0)).toBe('0 Bytes/s');
    });
});

describe('getFileExtension', () => {
    it('extracts simple extension', () => {
        expect(getFileExtension('file.txt')).toBe('txt');
    });

    it('returns empty string for no extension', () => {
        expect(getFileExtension('file')).toBe('');
    });

    it('lowercases the extension', () => {
        expect(getFileExtension('FILE.PDF')).toBe('pdf');
    });

    it('returns last extension for compound extensions', () => {
        expect(getFileExtension('archive.tar.gz')).toBe('gz');
    });

    it('handles dotfiles', () => {
        // ".gitignore" -> split gives ["", "gitignore"], length > 1, pop = "gitignore"
        expect(getFileExtension('.gitignore')).toBe('gitignore');
    });

    it('handles multiple dots', () => {
        expect(getFileExtension('my.file.name.txt')).toBe('txt');
    });

    it('handles empty string', () => {
        expect(getFileExtension('')).toBe('');
    });
});

describe('getFileIcon', () => {
    it('returns "image" for image types', () => {
        expect(getFileIcon('image/png')).toBe('image');
        expect(getFileIcon('image/jpeg')).toBe('image');
        expect(getFileIcon('image/gif')).toBe('image');
        expect(getFileIcon('image/svg+xml')).toBe('image');
    });

    it('returns "video" for video types', () => {
        expect(getFileIcon('video/mp4')).toBe('video');
        expect(getFileIcon('video/webm')).toBe('video');
        expect(getFileIcon('video/quicktime')).toBe('video');
    });

    it('returns "audio" for audio types', () => {
        expect(getFileIcon('audio/mp3')).toBe('audio');
        expect(getFileIcon('audio/mpeg')).toBe('audio');
        expect(getFileIcon('audio/wav')).toBe('audio');
    });

    it('returns "file-text" for text types', () => {
        expect(getFileIcon('text/plain')).toBe('file-text');
        expect(getFileIcon('text/html')).toBe('file-text');
        expect(getFileIcon('text/css')).toBe('file-text');
    });

    it('returns "file-text" for PDF', () => {
        expect(getFileIcon('application/pdf')).toBe('file-text');
    });

    it('returns "archive" for zip/archive types', () => {
        expect(getFileIcon('application/zip')).toBe('archive');
        expect(getFileIcon('application/x-tar')).toBe('file'); // no "zip" or "archive" substring
        expect(getFileIcon('application/x-zip-compressed')).toBe('archive');
    });

    it('returns "file" for unknown types', () => {
        expect(getFileIcon('application/octet-stream')).toBe('file');
        expect(getFileIcon('application/json')).toBe('file');
        expect(getFileIcon('')).toBe('file');
    });
});
