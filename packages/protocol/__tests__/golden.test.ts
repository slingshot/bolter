import { describe, expect, it } from 'bun:test';
import {
    arrayToB64,
    calculateEncryptedSize,
    createEncryptionStream,
    Keychain,
} from '../src/crypto';
import { buildUploadMetadata, decodeMetadata, encodeMetadata } from '../src/metadata';
import { getEffectivePartSize } from '../src/parts';
import golden from './vectors/golden.json';

/**
 * Byte-level conformance vectors.
 *
 * Files already stored on send.fm were written by the implementation these
 * were frozen from, and their keys exist only in URLs people are holding. A
 * change that alters any byte below does not just break a test — it makes
 * those files undecryptable, with no migration path, because the server
 * cannot read them either.
 *
 * So: if one of these fails, the change is wrong. Regenerating the fixture to
 * make it pass is the one repair that is never correct.
 */

const SECRET = Uint8Array.from(Buffer.from(golden.secretHex, 'hex'));
/** WebCrypto rather than Bun's hasher, so these vectors stay checkable from any host. */
async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 251);

async function encrypt(data: Uint8Array): Promise<Uint8Array> {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        },
    }).pipeThrough(createEncryptionStream(new Keychain(SECRET)));

    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

describe('key derivation', () => {
    it('derives the same secret encoding', () => {
        expect(new Keychain(SECRET).secretKeyB64).toBe(golden.secretB64);
    });

    it('derives the same auth key', async () => {
        expect(await new Keychain(SECRET).authKeyB64()).toBe(golden.authKeyB64);
    });
});

describe('send-v1 auth header', () => {
    it('signs an absent nonce as sixteen zero bytes', async () => {
        const kc = new Keychain(SECRET);
        kc.nonce = '';
        expect(await kc.authHeader()).toBe(golden.authHeaderEmptyNonce);
    });

    it('signs a server-issued nonce', async () => {
        const kc = new Keychain(SECRET);
        kc.nonce = arrayToB64(new Uint8Array(16).fill(9));
        expect(await kc.authHeader()).toBe(golden.authHeaderNonceOfNines);
    });
});

describe('metadata blob', () => {
    it('encrypts deterministically — the metadata IV is zero by design', async () => {
        const metadata = buildUploadMetadata({
            files: golden.metadataInput.files,
            encrypted: true,
        });
        expect(await encodeMetadata(metadata, new Keychain(SECRET))).toBe(golden.metadataEncrypted);
    });

    it('encodes an unencrypted blob as standard base64', async () => {
        const metadata = buildUploadMetadata({
            files: golden.metadataInput.files,
            encrypted: false,
        });
        expect(await encodeMetadata(metadata, null)).toBe(golden.metadataPlain);
    });

    it('still decodes the frozen ciphertext', async () => {
        const decoded = await decodeMetadata(golden.metadataEncrypted, new Keychain(SECRET));
        expect(decoded.files[0].name).toBe('report.pdf');
    });
});

describe('ECE ciphertext', () => {
    const cases = Object.entries(golden.ciphertext) as [
        string,
        { plaintextBytes: number; length: number; calculatedSize: number; sha256: string },
    ][];

    it.each(cases.map(([name, v]) => [name, v] as const))('%s', async (_name, vector) => {
        const bytes = await encrypt(pattern(vector.plaintextBytes));
        expect(bytes.length).toBe(vector.length);
        expect(await sha256(bytes)).toBe(vector.sha256);
        // The predicted size has to match the produced size, or a client sizes
        // its multipart allocation wrong and the upload fails at completion.
        expect(calculateEncryptedSize(vector.plaintextBytes)).toBe(vector.calculatedSize);
        expect(vector.calculatedSize).toBe(vector.length);
    });
});

describe('effective part size', () => {
    it.each(Object.entries(golden.effectivePartSize))('%s bytes', (partSize, expected) => {
        expect(getEffectivePartSize(Number(partSize), true)).toBe(expected);
    });
});
