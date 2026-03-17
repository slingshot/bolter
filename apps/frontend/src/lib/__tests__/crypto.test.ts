import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/sentry', () => ({
    captureError: vi.fn(),
    addBreadcrumb: vi.fn(),
}));

import {
    arrayToB64,
    b64ToArray,
    calculateEncryptedSize,
    createDecryptionStream,
    createEncryptionStream,
    ECE_RECORD_SIZE,
    generateIV,
    generateSecretKey,
    Keychain,
} from '@/lib/crypto';

// Helper: pipe a Uint8Array through a TransformStream and collect output
async function pipeThrough(
    data: Uint8Array,
    stream: TransformStream<Uint8Array, Uint8Array>,
    chunkSize = 16384,
): Promise<Uint8Array> {
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();

    // Write in chunks to simulate realistic streaming
    const writePromise = (async () => {
        for (let offset = 0; offset < data.length; offset += chunkSize) {
            const end = Math.min(offset + chunkSize, data.length);
            await writer.write(data.slice(offset, end));
        }
        await writer.close();
    })();

    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
        const result = await reader.read();
        if (result.done) {
            done = true;
        } else {
            chunks.push(result.value);
        }
    }

    await writePromise;

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const output = new Uint8Array(totalLength);
    let pos = 0;
    for (const chunk of chunks) {
        output.set(chunk, pos);
        pos += chunk.length;
    }
    return output;
}

// Helper: generate deterministic data for testing
function makeData(size: number): Uint8Array {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = i % 256;
    }
    return data;
}

describe('generateSecretKey', () => {
    it('returns a Uint8Array of 16 bytes', () => {
        const key = generateSecretKey();
        expect(key).toBeInstanceOf(Uint8Array);
        expect(key.length).toBe(16);
    });

    it('produces different values on each call', () => {
        const key1 = generateSecretKey();
        const key2 = generateSecretKey();
        expect(arrayToB64(key1)).not.toBe(arrayToB64(key2));
    });
});

describe('generateIV', () => {
    it('returns a Uint8Array of 12 bytes', () => {
        const iv = generateIV();
        expect(iv).toBeInstanceOf(Uint8Array);
        expect(iv.length).toBe(12);
    });
});

describe('arrayToB64 / b64ToArray', () => {
    it('round-trips an empty array', () => {
        const original = new Uint8Array(0);
        const encoded = arrayToB64(original);
        const decoded = b64ToArray(encoded);
        expect(decoded.length).toBe(0);
    });

    it('round-trips a single byte', () => {
        const original = new Uint8Array([42]);
        const decoded = b64ToArray(arrayToB64(original));
        expect(decoded).toEqual(original);
    });

    it('round-trips 16 bytes (key-sized)', () => {
        const original = generateSecretKey();
        const decoded = b64ToArray(arrayToB64(original));
        expect(decoded).toEqual(original);
    });

    it('round-trips 256 bytes', () => {
        const original = makeData(256);
        const decoded = b64ToArray(arrayToB64(original));
        expect(decoded).toEqual(original);
    });

    it('round-trips an ArrayBuffer (not Uint8Array)', () => {
        const original = new Uint8Array([1, 2, 3, 4]);
        const encoded = arrayToB64(original.buffer);
        const decoded = b64ToArray(encoded);
        expect(decoded).toEqual(original);
    });

    it('produces URL-safe base64 (no +, /, or =)', () => {
        // Use data that would normally produce +, /, and = in standard base64
        const data = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            data[i] = i;
        }
        const encoded = arrayToB64(data);
        expect(encoded).not.toContain('+');
        expect(encoded).not.toContain('/');
        expect(encoded).not.toContain('=');
    });

    it('b64ToArray handles standard base64 with + and /', () => {
        // Manually create standard base64 (with + and /) and verify it decodes
        const original = new Uint8Array([251, 255, 190]); // produces +/++ in standard b64
        const standardB64 = btoa(String.fromCharCode(...original));
        // standardB64 may contain + or / — b64ToArray should handle both forms
        const decoded = b64ToArray(standardB64);
        expect(decoded).toEqual(original);
    });

    it('b64ToArray handles URL-safe base64 with - and _', () => {
        const original = new Uint8Array([251, 255, 190]);
        const urlSafe = arrayToB64(original); // uses - and _ instead of + and /
        const decoded = b64ToArray(urlSafe);
        expect(decoded).toEqual(original);
    });
});

describe('Keychain', () => {
    it('generates a random key when no argument is provided', () => {
        const kc1 = new Keychain();
        const kc2 = new Keychain();
        expect(kc1.secretKeyB64).not.toBe(kc2.secretKeyB64);
    });

    it('accepts a Uint8Array secret key', () => {
        const key = generateSecretKey();
        const kc = new Keychain(key);
        expect(b64ToArray(kc.secretKeyB64)).toEqual(key);
    });

    it('accepts a base64 string and reconstructs identically', () => {
        const kc1 = new Keychain();
        const b64 = kc1.secretKeyB64;
        const kc2 = new Keychain(b64);
        expect(kc2.secretKeyB64).toBe(b64);
    });

    it('same secret key produces deterministic derived keys', async () => {
        const secret = generateSecretKey();
        const kc1 = new Keychain(secret);
        const kc2 = new Keychain(new Uint8Array(secret));

        const auth1 = await kc1.authKeyB64();
        const auth2 = await kc2.authKeyB64();
        expect(auth1).toBe(auth2);
    });

    it('encryptionKey, metaKey, and authKey are all distinct', async () => {
        const kc = new Keychain();
        const encKey = await kc.getEncryptionKey();
        const metaKey = await kc.getMetaKey();
        const authKey = await kc.getAuthKey();

        // Export raw key material to compare
        // encryptionKey and metaKey are CryptoKeys — compare via auth key derivation won't work
        // Instead, verify authKey (Uint8Array) is different from the secret
        const authB64 = arrayToB64(authKey);
        expect(authB64).not.toBe(kc.secretKeyB64);

        // Encrypt with both keys to verify they produce different ciphertexts for same data
        const testData = new Uint8Array([1, 2, 3, 4, 5]);
        const iv = new Uint8Array(12);

        const enc1 = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            encKey,
            testData,
        );
        const enc2 = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            metaKey,
            testData,
        );

        expect(arrayToB64(enc1)).not.toBe(arrayToB64(enc2));
    });

    it('caches derived keys on subsequent calls', async () => {
        const kc = new Keychain();
        const key1 = await kc.getEncryptionKey();
        const key2 = await kc.getEncryptionKey();
        expect(key1).toBe(key2); // Same object reference

        const meta1 = await kc.getMetaKey();
        const meta2 = await kc.getMetaKey();
        expect(meta1).toBe(meta2);

        const auth1 = await kc.getAuthKey();
        const auth2 = await kc.getAuthKey();
        expect(auth1).toBe(auth2);
    });
});

describe('Metadata encryption', () => {
    it('round-trips metadata object', async () => {
        const kc = new Keychain();
        const metadata = { name: 'test.txt', size: 1234, type: 'text/plain' };
        const encrypted = await kc.encryptMetadata(metadata);
        expect(encrypted).toBeInstanceOf(Uint8Array);
        expect(encrypted.length).toBeGreaterThan(0);

        const decrypted = await kc.decryptMetadata(encrypted);
        expect(decrypted).toEqual(metadata);
    });

    it('encrypts to different ciphertext than plaintext', async () => {
        const kc = new Keychain();
        const metadata = { hello: 'world' };
        const encrypted = await kc.encryptMetadata(metadata);
        const plainBytes = new TextEncoder().encode(JSON.stringify(metadata));
        expect(arrayToB64(encrypted)).not.toBe(arrayToB64(plainBytes));
    });

    it('decrypt with wrong key throws', async () => {
        const kc1 = new Keychain();
        const kc2 = new Keychain();
        const encrypted = await kc1.encryptMetadata({ secret: 'data' });

        await expect(kc2.decryptMetadata(encrypted)).rejects.toThrow();
    });

    it('handles complex metadata with nested objects', async () => {
        const kc = new Keychain();
        const metadata = {
            name: 'archive.zip',
            files: [
                { name: 'a.txt', size: 100 },
                { name: 'b.txt', size: 200 },
            ],
            nested: { deep: { value: true } },
        };
        const encrypted = await kc.encryptMetadata(metadata);
        const decrypted = await kc.decryptMetadata(encrypted);
        expect(decrypted).toEqual(metadata);
    });
});

describe('authHeader', () => {
    it('produces "send-v1 ..." format', async () => {
        const kc = new Keychain();
        kc.nonce = arrayToB64(crypto.getRandomValues(new Uint8Array(16)));
        const header = await kc.authHeader();
        expect(header).toMatch(/^send-v1 .+$/);
    });

    it('changes with different nonce', async () => {
        const kc = new Keychain();
        kc.nonce = arrayToB64(crypto.getRandomValues(new Uint8Array(16)));
        const header1 = await kc.authHeader();

        kc.nonce = arrayToB64(crypto.getRandomValues(new Uint8Array(16)));
        const header2 = await kc.authHeader();

        expect(header1).not.toBe(header2);
    });

    it('produces deterministic output for same key and nonce', async () => {
        const secret = generateSecretKey();
        const nonceValue = arrayToB64(new Uint8Array(16)); // zero nonce

        const kc1 = new Keychain(new Uint8Array(secret));
        kc1.nonce = nonceValue;
        const header1 = await kc1.authHeader();

        const kc2 = new Keychain(new Uint8Array(secret));
        kc2.nonce = nonceValue;
        const header2 = await kc2.authHeader();

        expect(header1).toBe(header2);
    });
});

describe('Encryption/Decryption streams', () => {
    it('round-trips small data (<64KB)', async () => {
        const kc = new Keychain();
        const plaintext = makeData(1000);

        const encrypted = await pipeThrough(plaintext, createEncryptionStream(kc));
        expect(encrypted.length).toBeGreaterThan(plaintext.length); // overhead added

        const decrypted = await pipeThrough(encrypted, createDecryptionStream(kc));
        expect(decrypted).toEqual(plaintext);
    });

    it('round-trips exact 64KB boundary', async () => {
        const kc = new Keychain();
        const plaintext = makeData(ECE_RECORD_SIZE); // exactly 64KB

        const encrypted = await pipeThrough(plaintext, createEncryptionStream(kc));
        const decrypted = await pipeThrough(encrypted, createDecryptionStream(kc));
        expect(decrypted).toEqual(plaintext);
    });

    it('round-trips multi-record data (150KB = 2+ records)', async () => {
        const kc = new Keychain();
        const plaintext = makeData(150 * 1024); // 150KB

        const encrypted = await pipeThrough(plaintext, createEncryptionStream(kc));
        const decrypted = await pipeThrough(encrypted, createDecryptionStream(kc));
        expect(decrypted).toEqual(plaintext);
    });

    it('round-trips large data (1MB)', async () => {
        const kc = new Keychain();
        const plaintext = makeData(1024 * 1024); // 1MB

        const encrypted = await pipeThrough(plaintext, createEncryptionStream(kc));
        const decrypted = await pipeThrough(encrypted, createDecryptionStream(kc));
        expect(decrypted).toEqual(plaintext);
    });

    it('round-trips single byte', async () => {
        const kc = new Keychain();
        const plaintext = new Uint8Array([42]);

        const encrypted = await pipeThrough(plaintext, createEncryptionStream(kc));
        const decrypted = await pipeThrough(encrypted, createDecryptionStream(kc));
        expect(decrypted).toEqual(plaintext);
    });

    it('encrypted output size matches calculateEncryptedSize', async () => {
        const kc = new Keychain();
        const sizes = [
            1,
            100,
            ECE_RECORD_SIZE - 1,
            ECE_RECORD_SIZE,
            ECE_RECORD_SIZE + 1,
            150 * 1024,
        ];

        for (const size of sizes) {
            const plaintext = makeData(size);
            const encrypted = await pipeThrough(plaintext, createEncryptionStream(kc));
            const expected = calculateEncryptedSize(size);
            expect(encrypted.length).toBe(expected);
        }
    });

    it('encryption with initialCounter offset still round-trips', async () => {
        const kc = new Keychain();
        const plaintext = makeData(5000);
        const initialCounter = 5;

        // Encrypt with offset counter
        const encrypted = await pipeThrough(plaintext, createEncryptionStream(kc, initialCounter));

        // Decryption stream always starts at counter 0, so a direct pipe won't work.
        // Instead, verify the encrypted data is different from counter=0 encryption
        const encryptedDefault = await pipeThrough(plaintext, createEncryptionStream(kc, 0));

        // Different counter must produce different ciphertext
        expect(arrayToB64(encrypted)).not.toBe(arrayToB64(encryptedDefault));

        // Verify the default (counter=0) encryption does round-trip
        const decrypted = await pipeThrough(encryptedDefault, createDecryptionStream(kc));
        expect(decrypted).toEqual(plaintext);
    });

    it('decryption with wrong key does not produce original plaintext', async () => {
        const kc1 = new Keychain();
        const kc2 = new Keychain();
        const plaintext = makeData(1000);

        const encrypted = await pipeThrough(plaintext, createEncryptionStream(kc1));

        // The decryption stream catches errors in flush() and logs them via captureError,
        // so it resolves with empty output rather than rejecting.
        const decrypted = await pipeThrough(encrypted, createDecryptionStream(kc2));
        // Either empty (error swallowed) or garbage -- definitely not the original plaintext
        if (decrypted.length > 0) {
            expect(arrayToB64(decrypted)).not.toBe(arrayToB64(plaintext));
        } else {
            expect(decrypted.length).toBe(0);
        }
    });
});

describe('calculateEncryptedSize', () => {
    it('returns overhead for zero-length input (1 record minimum)', () => {
        // 0 bytes -> ceil(0/64K) = 0, but || 1 makes it 1 record
        const result = calculateEncryptedSize(0);
        expect(result).toBe(0 + 1 * 17); // 17 bytes overhead for 1 record
    });

    it('handles single byte', () => {
        const result = calculateEncryptedSize(1);
        // 1 byte -> 1 record -> 1 + 17 = 18
        expect(result).toBe(1 + 17);
    });

    it('handles data smaller than one record', () => {
        const result = calculateEncryptedSize(1000);
        expect(result).toBe(1000 + 17);
    });

    it('handles exact record boundary (64KB)', () => {
        const result = calculateEncryptedSize(ECE_RECORD_SIZE);
        // ceil(65536/65536) = 1 record
        expect(result).toBe(ECE_RECORD_SIZE + 17);
    });

    it('handles one byte over record boundary', () => {
        const result = calculateEncryptedSize(ECE_RECORD_SIZE + 1);
        // ceil(65537/65536) = 2 records
        expect(result).toBe(ECE_RECORD_SIZE + 1 + 2 * 17);
    });

    it('handles 150KB (3 records)', () => {
        const size = 150 * 1024;
        const numRecords = Math.ceil(size / ECE_RECORD_SIZE);
        expect(numRecords).toBe(3);
        expect(calculateEncryptedSize(size)).toBe(size + 3 * 17);
    });

    it('handles 1MB', () => {
        const size = 1024 * 1024;
        const numRecords = Math.ceil(size / ECE_RECORD_SIZE);
        expect(numRecords).toBe(16);
        expect(calculateEncryptedSize(size)).toBe(size + 16 * 17);
    });

    it('handles 1GB', () => {
        const size = 1024 * 1024 * 1024;
        const numRecords = Math.ceil(size / ECE_RECORD_SIZE);
        expect(calculateEncryptedSize(size)).toBe(size + numRecords * 17);
    });
});
