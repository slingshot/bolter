import { describe, expect, it } from 'bun:test';
import pino from 'pino';
import { logger, redactPaths } from '../logger';

// ---------------------------------------------------------------------------
// #35 — pino runs at `info` in production, so anything handed to a log object
// reaches the log sink. Owner/deletion tokens and full pre-signed S3 URLs are
// bearer credentials: log-read access must not become delete/overwrite
// authority. Call sites must not log them at all; this redact config is the
// defense-in-depth backstop, so it has to actually work.
// ---------------------------------------------------------------------------

/** Capture what the real application logger writes for one record. */
function captureAppLog(obj: Record<string, unknown>): string {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    };
    try {
        logger.info(obj, 'redaction test');
    } finally {
        (process.stdout as unknown as { write: unknown }).write = original;
    }
    return chunks.join('');
}

/** Same paths, isolated instance — used to prove the path list itself is valid. */
function captureWithPaths(obj: Record<string, unknown>): string {
    const lines: string[] = [];
    const stream = {
        write(line: string) {
            lines.push(line);
        },
    };
    const isolated = pino(
        { redact: { paths: redactPaths, censor: '[redacted]' } },
        stream as unknown as NodeJS.WritableStream,
    );
    isolated.info(obj, 'test');
    return lines.join('');
}

const SIGNED_URL =
    'https://bucket.r2.cloudflarestorage.com/abc123?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=604800';

describe('application logger redaction', () => {
    it('should redact the owner token from a real log record', () => {
        const line = captureAppLog({ id: 'abc123', owner: 'ownertoken1234567890' });

        expect(line).toContain('[redacted]');
        expect(line).not.toContain('ownertoken1234567890');
        // Non-secret context must survive so logs stay useful
        expect(line).toContain('abc123');
    });

    it('should redact a full pre-signed URL from a real log record', () => {
        const line = captureAppLog({ id: 'abc123', fullUrl: SIGNED_URL });

        expect(line).toContain('[redacted]');
        expect(line).not.toContain('X-Amz-Signature');
    });
});

describe('logger redact path coverage', () => {
    it('should redact pre-signed URLs under every field name they get logged as', () => {
        for (const field of ['url', 'uploadUrl', 'fullUrl', 'urlPreview', 'firstPartUrl']) {
            const line = captureWithPaths({ id: 'abc123', [field]: SIGNED_URL });
            expect(line).not.toContain('X-Amz-Signature');
        }
    });

    it('should redact the upload-owner token and auth key', () => {
        const line = captureWithPaths({ uploadToken: 'uploadtok123', authKey: 'authkey456' });
        expect(line).not.toContain('uploadtok123');
        expect(line).not.toContain('authkey456');
    });

    it('should redact provider credentials', () => {
        const line = captureWithPaths({ secretAccessKey: 'supersecret', accessKeyId: 'AKIAXXXX' });
        expect(line).not.toContain('supersecret');
        expect(line).not.toContain('AKIAXXXX');
    });

    it('should redact secrets nested one level deep', () => {
        const line = captureWithPaths({ extra: { owner: 'nestedowner1234' } });
        expect(line).not.toContain('nestedowner1234');
    });
});
