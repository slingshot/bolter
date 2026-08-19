import { describe, expect, it } from 'bun:test';
import { ECE_VERSION, Keychain } from '../src/crypto';
import {
    buildUploadMetadata,
    decodeMetadata,
    describeMetadata,
    encodeMetadata,
} from '../src/metadata';

const file = (name: string, size: number, type = 'text/plain') => ({ name, size, type });

describe('buildUploadMetadata', () => {
    it('stamps the ECE version only when encrypted', () => {
        expect(buildUploadMetadata({ files: [file('a.txt', 1)], encrypted: true }).eceVersion).toBe(
            ECE_VERSION,
        );
        expect(
            buildUploadMetadata({ files: [file('a.txt', 1)], encrypted: false }).eceVersion,
        ).toBeUndefined();
    });

    it('marks an archive only when several files share one object', () => {
        const one = buildUploadMetadata({
            files: [file('a.txt', 1)],
            encrypted: false,
            zipFilename: 'x.zip',
        });
        expect(one.zipped).toBeUndefined();

        const many = buildUploadMetadata({
            files: [file('a.txt', 1), file('b.txt', 2)],
            encrypted: false,
            zipFilename: 'x.zip',
        });
        expect(many.zipped).toBe(true);
        expect(many.zipFilename).toBe('x.zip');
    });

    it('defaults a missing MIME type rather than emitting an empty one', () => {
        const m = buildUploadMetadata({ files: [file('a', 1, '')], encrypted: false });
        expect(m.files[0].type).toBe('application/octet-stream');
    });
});

describe('encode/decode round trip', () => {
    it('round-trips an unencrypted blob as standard base64 of UTF-8 JSON', async () => {
        const metadata = buildUploadMetadata({
            files: [file('héllo wörld.txt', 42)],
            encrypted: false,
        });
        const encoded = await encodeMetadata(metadata, null);
        // Standard base64, not the URL-safe variant used for ciphertext.
        expect(encoded).toBe(
            btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(metadata)))),
        );
        expect(await decodeMetadata(encoded, null)).toEqual(metadata);
    });

    it('round-trips an encrypted blob through the metadata key', async () => {
        const keychain = new Keychain(new Uint8Array(16).fill(4));
        const metadata = buildUploadMetadata({ files: [file('secret.bin', 9)], encrypted: true });
        const encoded = await encodeMetadata(metadata, keychain);
        expect(encoded).not.toContain('=');
        expect(await decodeMetadata(encoded, new Keychain(new Uint8Array(16).fill(4)))).toEqual(
            metadata,
        );
    });

    it('fails to decode with the wrong key rather than returning garbage', async () => {
        const metadata = buildUploadMetadata({ files: [file('a', 1)], encrypted: true });
        const encoded = await encodeMetadata(metadata, new Keychain(new Uint8Array(16).fill(4)));
        await expect(
            decodeMetadata(encoded, new Keychain(new Uint8Array(16).fill(5))),
        ).rejects.toThrow();
    });
});

describe('describeMetadata', () => {
    it('names the archive for a zipped share, not its first member', () => {
        expect(
            describeMetadata({
                files: [file('a.txt', 1), file('b.txt', 2)],
                zipped: true,
                zipFilename: 'bundle.zip',
                size: 3,
            }).name,
        ).toBe('bundle.zip');
    });

    it('reads a legacy single-file share from the root fields', () => {
        expect(describeMetadata({ files: [], name: 'old.bin', size: 7, type: 'x/y' })).toEqual({
            name: 'old.bin',
            size: 7,
            type: 'x/y',
        });
    });
});
