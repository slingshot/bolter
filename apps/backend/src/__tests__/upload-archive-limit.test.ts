/**
 * Audit #5 — MAX_FILES_PER_ARCHIVE was advertised via GET /config but never
 * enforced on any route.
 *
 * Archives are assembled client-side, so the count only reaches the server
 * inside the metadata blob. For unencrypted shares that blob is base64 UTF-8
 * JSON with a countable `files[]`; encrypted metadata is E2E ciphertext and is
 * deliberately left unenforceable rather than broken open.
 */
import { describe, expect, it } from 'bun:test';

const REAL_UPLOAD_MODULE = '../routes/upload.ts?unmocked' as string;
const { countDeclaredFiles } = (await import(
    REAL_UPLOAD_MODULE
)) as typeof import('../routes/upload');

/** Exactly how the client encodes metadata (`api.ts` uploadFiles). */
function encodeMetadata(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('countDeclaredFiles (#5)', () => {
    it('counts the files declared in an unencrypted metadata blob', () => {
        const metadata = encodeMetadata({
            files: [
                { name: 'a.bin', size: 1, type: '' },
                { name: 'b.bin', size: 2, type: '' },
                { name: 'c.bin', size: 3, type: '' },
            ],
        });
        expect(countDeclaredFiles(metadata)).toBe(3);
    });

    it('counts a single-file share as 1', () => {
        expect(countDeclaredFiles(encodeMetadata({ files: [{ name: 'a.bin' }] }))).toBe(1);
    });

    it('survives non-ASCII filenames (the client encodes UTF-8 before base64)', () => {
        const metadata = encodeMetadata({ files: [{ name: 'reçu-café-日本語.pdf' }] });
        expect(countDeclaredFiles(metadata)).toBe(1);
    });

    it('returns null for ciphertext, so encrypted shares are never falsely rejected', () => {
        // Random bytes stand in for an encrypted metadata envelope.
        const ciphertext = Buffer.from(
            crypto.getRandomValues(new Uint8Array(128)) as Uint8Array,
        ).toString('base64');
        expect(countDeclaredFiles(ciphertext)).toBeNull();
    });

    it('returns null rather than throwing on malformed input', () => {
        expect(countDeclaredFiles('')).toBeNull();
        expect(countDeclaredFiles('not-base64-!!!')).toBeNull();
        expect(countDeclaredFiles(encodeMetadata({ noFilesKey: true }))).toBeNull();
        expect(countDeclaredFiles(encodeMetadata({ files: 'not-an-array' }))).toBeNull();
        expect(countDeclaredFiles(encodeMetadata(null))).toBeNull();
    });

    it('is the value the gate compares against config.maxFilesPerArchive', () => {
        // The gate is `declaredFiles !== null && declaredFiles > max`. Pin the
        // boundary: exactly-at-the-limit must pass, one over must be rejected.
        const max = 100;
        const atLimit = encodeMetadata({
            files: Array.from({ length: max }, () => ({ name: 'f' })),
        });
        const overLimit = encodeMetadata({
            files: Array.from({ length: max + 1 }, () => ({ name: 'f' })),
        });

        const atCount = countDeclaredFiles(atLimit);
        const overCount = countDeclaredFiles(overLimit);

        expect(atCount).not.toBeNull();
        expect(overCount).not.toBeNull();
        expect((atCount as number) > max).toBe(false);
        expect((overCount as number) > max).toBe(true);
    });
});
