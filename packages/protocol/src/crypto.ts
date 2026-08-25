/**
 * Crypto utilities for client-side encryption
 * Uses Web Crypto API for AES-GCM encryption and HKDF key derivation
 */

import { reportError } from './telemetry';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ECE (Encrypted Content Encoding) configuration
export const ECE_RECORD_SIZE = 64 * 1024; // 64KB record size
const TAG_LENGTH = 16; // AES-GCM tag length
const NONCE_LENGTH = 12; // AES-GCM nonce length
export const ECE_ENCRYPTED_RECORD_SIZE = ECE_RECORD_SIZE + TAG_LENGTH + 1;

/**
 * ECE ciphertext format version, recorded per-file in the client-encrypted
 * metadata blob (`eceVersion`) at upload time.
 *
 * ECE ciphertext carries no in-band version header, so the decryptor cannot
 * distinguish a stream that legitimately ends without a final-flagged record
 * (produced by pre-versioning clients whose plaintext was an exact
 * record-size multiple) from one a malicious storage provider truncated at a
 * record boundary. Recording the version alongside the file lets the
 * decryptor fail closed for everything it knows was written by a client that
 * always emits a final record, while still decrypting genuinely legacy data.
 *
 * The marker lives inside the AES-GCM-authenticated metadata (keyed by the
 * secret in the download URL fragment), so neither the storage provider nor
 * the metadata server can forge or strip it.
 *
 * Version 1 = the encryptor always emits a final-flagged record, including for
 * exact-record-multiple and empty plaintexts.
 */
export const ECE_VERSION = 1;

/**
 * First ECE version whose writer is guaranteed to emit a final-flagged record.
 *
 * Deliberately a fixed floor rather than `ECE_VERSION`: every version from 1
 * onwards always terminates the stream with a final record, so bumping
 * `ECE_VERSION` for an unrelated format change must not silently downgrade the
 * millions of already-stored v1 files back to the fail-open legacy path.
 */
const ECE_MIN_VERSION_WITH_FINAL_RECORD = 1;

/**
 * Read the ECE format version from a file's decrypted metadata.
 *
 * Returns 0 when the marker is absent or not a positive number, i.e. metadata
 * written before versioning existed. Only that case is permitted to decrypt a
 * stream with no trailing final record.
 */
export function readEceVersion(metadata: unknown): number {
    if (typeof metadata !== 'object' || metadata === null) {
        return 0;
    }
    const value = (metadata as { eceVersion?: unknown }).eceVersion;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return value;
}

// Key derivation info strings
const KEY_INFO = encoder.encode('Content-Encoding: aes128gcm');
// NONCE_INFO kept as a comment for documentation: encoder.encode('Content-Encoding: nonce')
const AUTH_INFO = encoder.encode('Content-Encoding: auth');
const META_INFO = encoder.encode('Content-Encoding: meta');

/**
 * Generate a random secret key
 */
export function generateSecretKey(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Generate a random IV
 */
export function generateIV(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(12));
}

/**
 * Convert array buffer to base64 URL-safe string
 */
export function arrayToB64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Convert base64 URL-safe string to Uint8Array
 */
export function b64ToArray(base64: string): Uint8Array {
    const str = base64.replace(/-/g, '+').replace(/_/g, '/');
    const paddedStr = str + '==='.slice(0, (4 - (str.length % 4)) % 4);
    const binary = atob(paddedStr);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * HKDF key derivation
 */
async function hkdf(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, [
        'deriveBits',
    ]);

    const bits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: salt as BufferSource,
            info: info as BufferSource,
        },
        key,
        length * 8,
    );

    return new Uint8Array(bits);
}

/**
 * Keychain class for managing encryption keys
 */
export class Keychain {
    private secretKey: Uint8Array;
    private encryptionKey: CryptoKey | null = null;
    private metaKey: CryptoKey | null = null;
    private authKey: Uint8Array | null = null;
    public nonce: string = '';

    constructor(secretKey?: Uint8Array | string) {
        if (typeof secretKey === 'string') {
            this.secretKey = b64ToArray(secretKey);
        } else if (secretKey) {
            this.secretKey = secretKey;
        } else {
            this.secretKey = generateSecretKey();
        }
    }

    /**
     * Get the secret key as base64
     */
    get secretKeyB64(): string {
        return arrayToB64(this.secretKey);
    }

    /**
     * Derive the encryption key for file content
     */
    async getEncryptionKey(): Promise<CryptoKey> {
        if (this.encryptionKey) {
            return this.encryptionKey;
        }

        const salt = new Uint8Array(16);
        const keyMaterial = await hkdf(this.secretKey, salt, KEY_INFO, 16);

        this.encryptionKey = await crypto.subtle.importKey(
            'raw',
            keyMaterial as BufferSource,
            { name: 'AES-GCM', length: 128 },
            false,
            ['encrypt', 'decrypt'],
        );

        return this.encryptionKey;
    }

    /**
     * Derive the metadata encryption key
     */
    async getMetaKey(): Promise<CryptoKey> {
        if (this.metaKey) {
            return this.metaKey;
        }

        const salt = new Uint8Array(16);
        const keyMaterial = await hkdf(this.secretKey, salt, META_INFO, 16);

        this.metaKey = await crypto.subtle.importKey(
            'raw',
            keyMaterial as BufferSource,
            { name: 'AES-GCM', length: 128 },
            false,
            ['encrypt', 'decrypt'],
        );

        return this.metaKey;
    }

    /**
     * Derive the authentication key
     */
    async getAuthKey(): Promise<Uint8Array> {
        if (this.authKey) {
            return this.authKey;
        }

        const salt = new Uint8Array(16);
        this.authKey = await hkdf(this.secretKey, salt, AUTH_INFO, 64);

        return this.authKey;
    }

    /**
     * Get auth key as base64
     */
    async authKeyB64(): Promise<string> {
        const key = await this.getAuthKey();
        return arrayToB64(key);
    }

    /**
     * Generate authentication header for API requests
     */
    async authHeader(): Promise<string> {
        const authKey = await this.getAuthKey();
        const nonceBytes = this.nonce ? b64ToArray(this.nonce) : new Uint8Array(16);

        // HMAC-SHA256(authKey, nonce)
        const key = await crypto.subtle.importKey(
            'raw',
            authKey as BufferSource,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );

        const sig = await crypto.subtle.sign('HMAC', key, nonceBytes as BufferSource);
        return `send-v1 ${arrayToB64(sig)}`;
    }

    /**
     * Encrypt metadata object
     */
    async encryptMetadata(metadata: object): Promise<Uint8Array> {
        const key = await this.getMetaKey();
        const iv = new Uint8Array(12); // Zero IV for metadata
        const data = encoder.encode(JSON.stringify(metadata));

        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            key,
            data,
        );

        return new Uint8Array(encrypted);
    }

    /**
     * Decrypt metadata
     */
    async decryptMetadata(encryptedData: Uint8Array): Promise<object> {
        const key = await this.getMetaKey();
        const iv = new Uint8Array(12); // Zero IV for metadata

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            key,
            encryptedData as BufferSource,
        );

        return JSON.parse(decoder.decode(decrypted));
    }
}

export interface EncryptionStreamOptions {
    /**
     * Record counter this stream starts at. Non-zero when encrypting a slice
     * that begins partway through a file — the counter is what ties a record's
     * ciphertext to its position, so a slice must resume the sequence exactly.
     */
    initialCounter?: number;
    /**
     * Whether to close the stream with the final-flagged record.
     *
     * True (the default) for a whole file or the trailing part. **False when
     * encrypting a middle part**, because the final flag is what tells a
     * decryptor the file ends here — emitting it mid-file would make every
     * part look like a complete, truncated file, and the concatenation would
     * not match a whole-stream encryption of the same bytes.
     *
     * With `finalize: false` the input must be a whole number of records; a
     * partial record has no legal non-final representation and throws rather
     * than silently producing a part that cannot be reassembled.
     */
    finalize?: boolean;
}

/**
 * Create encryption transform stream for file content.
 *
 * Accepts a bare counter for the common case; the options form exists so a
 * client with random access to its source can regenerate any single part on
 * demand — which is what makes a byte-identical retry free, with no staged
 * copy of the ciphertext.
 */
export function createEncryptionStream(
    keychain: Keychain,
    options: number | EncryptionStreamOptions = 0,
): TransformStream<Uint8Array, Uint8Array> {
    const { initialCounter = 0, finalize = true } =
        typeof options === 'number' ? { initialCounter: options } : options;
    let recordCount = initialCounter;
    let buffer = new Uint8Array(0);
    let encryptionKey: CryptoKey;

    return new TransformStream({
        async start() {
            encryptionKey = await keychain.getEncryptionKey();
        },

        async transform(chunk, controller) {
            // Accumulate data into buffer
            const newBuffer = new Uint8Array(buffer.length + chunk.length);
            newBuffer.set(buffer);
            newBuffer.set(chunk, buffer.length);
            buffer = newBuffer;

            // Process complete records
            while (buffer.length >= ECE_RECORD_SIZE) {
                const record = buffer.slice(0, ECE_RECORD_SIZE);
                buffer = buffer.slice(ECE_RECORD_SIZE);

                const encrypted = await encryptRecord(encryptionKey, record, recordCount, false);
                controller.enqueue(encrypted);
                recordCount++;
            }
        },

        async flush(controller) {
            if (!finalize) {
                // A middle slice ends exactly on a record boundary by
                // construction; anything left over means the caller cut the
                // part somewhere no decryptor can rejoin.
                if (buffer.length > 0) {
                    controller.error(
                        new Error(
                            `non-final encryption stream ended mid-record with ${buffer.length} ` +
                                `bytes buffered (records are ${ECE_RECORD_SIZE} bytes)`,
                        ),
                    );
                }
                return;
            }
            // Always emit a final-flagged record (empty when the plaintext is an
            // exact record-size multiple) so truncation at a record boundary is
            // detectable by the decryptor.
            const encrypted = await encryptRecord(encryptionKey, buffer, recordCount, true);
            controller.enqueue(encrypted);
        },
    });
}

/**
 * Encrypt a single record using AES-GCM
 */
async function encryptRecord(
    key: CryptoKey,
    data: Uint8Array,
    counter: number,
    isFinal: boolean,
): Promise<Uint8Array> {
    // Generate nonce from counter
    const nonce = new Uint8Array(NONCE_LENGTH);
    const view = new DataView(nonce.buffer);
    view.setUint32(0, counter, false);
    if (isFinal) {
        nonce[0] |= 0x80; // Set final record flag
    }

    // Add delimiter byte
    const paddedData = new Uint8Array(data.length + 1);
    paddedData.set(data);
    paddedData[data.length] = isFinal ? 2 : 1; // Delimiter

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH * 8 },
        key,
        paddedData,
    );

    return new Uint8Array(encrypted);
}

export interface DecryptionStreamOptions {
    /**
     * Record counter this stream starts at.
     *
     * Non-zero when decrypting a *range* of a file rather than the whole of
     * it, which is what lets a client fetch ranges in parallel and decrypt
     * each one as it lands. Exactly mirrors the encryptor: a record's nonce is
     * derived from its index, so a range that starts on a record boundary is
     * self-sufficient given the right starting count.
     */
    initialCounter?: number;
    /**
     * Whether the absence of a final-flagged record is an error.
     *
     * False for a range that is not the end of the file, where there is no
     * final record to find. The whole-file guarantee is then reasserted by the
     * caller, which knows how many plaintext bytes it should have ended up
     * with.
     */
    expectFinalRecord?: boolean;
    /**
     * ECE format version taken from the file's authenticated metadata via
     * `readEceVersion(metadata)`. `>= ECE_MIN_VERSION_WITH_FINAL_RECORD` means
     * the ciphertext was written by a client that always emits a final-flagged
     * record, so a missing final record is truncation or tampering and fails
     * closed. 0 means pre-versioning data, which may legitimately lack one and
     * is decrypted with warning telemetry only.
     *
     * Required, with no default: omitting it would silently select the
     * fail-open legacy path, which is precisely the vulnerability the marker
     * exists to close. Callers that genuinely have no marker must say so by
     * passing 0.
     */
    eceVersion: number;
}

/**
 * Create decryption transform stream for file content
 */
export function createDecryptionStream(
    keychain: Keychain,
    options: DecryptionStreamOptions,
): TransformStream<Uint8Array, Uint8Array> {
    const eceVersion = options.eceVersion;
    const requireFinalRecord =
        (options.expectFinalRecord ?? true) && eceVersion >= ECE_MIN_VERSION_WITH_FINAL_RECORD;
    let recordCount = options.initialCounter ?? 0;
    let buffer = new Uint8Array(0);
    let encryptionKey: CryptoKey;
    let sawFinal = false;

    return new TransformStream({
        async start() {
            encryptionKey = await keychain.getEncryptionKey();
        },

        async transform(chunk, controller) {
            // Accumulate data into buffer
            const newBuffer = new Uint8Array(buffer.length + chunk.length);
            newBuffer.set(buffer);
            newBuffer.set(chunk, buffer.length);
            buffer = newBuffer;

            // Process complete encrypted records
            while (buffer.length >= ECE_ENCRYPTED_RECORD_SIZE) {
                const record = buffer.slice(0, ECE_ENCRYPTED_RECORD_SIZE);
                buffer = buffer.slice(ECE_ENCRYPTED_RECORD_SIZE);

                const { data: decrypted, isFinal } = await decryptRecord(
                    encryptionKey,
                    record,
                    recordCount,
                );
                if (isFinal) {
                    sawFinal = true;
                }
                if (decrypted.length > 0) {
                    controller.enqueue(decrypted);
                }
                recordCount++;
            }
        },

        async flush(controller) {
            // Decrypt final record (may be less than full encrypted record size)
            if (buffer.length > 0) {
                try {
                    const { data: decrypted, isFinal } = await decryptRecord(
                        encryptionKey,
                        buffer,
                        recordCount,
                    );
                    if (isFinal) {
                        sawFinal = true;
                    }
                    if (decrypted.length > 0) {
                        controller.enqueue(decrypted);
                    }
                } catch (e) {
                    console.error('Failed to decrypt final record:', e);
                    reportError(e, {
                        operation: 'crypto.decryptRecord',
                        extra: { recordCount, bufferLength: buffer.length },
                    });
                    controller.error(e instanceof Error ? e : new Error(String(e)));
                    return;
                }
            }

            if (sawFinal) {
                return;
            }

            if (requireFinalRecord) {
                // Versioned ciphertext always ends with a final-flagged record.
                // Its absence means the stored object was truncated at a record
                // boundary — exactly what the final record exists to detect, and
                // reachable by a malicious storage provider serving a matching
                // Content-Length. Fail closed instead of handing back a partial
                // file that looks complete.
                const err = new Error(
                    'Encrypted file is incomplete: the final record is missing, so this download was truncated or tampered with.',
                );
                console.error('Encrypted stream ended without final record', {
                    recordCount,
                    eceVersion,
                });
                reportError(err, {
                    operation: 'crypto.missingFinalRecord',
                    extra: { recordCount, eceVersion },
                });
                controller.error(err);
                return;
            }

            // Pre-versioning uploads with exact-record-multiple plaintexts have
            // no final-flagged record, so this is not an error for them — but
            // track occurrences for telemetry.
            reportError(new Error('Encrypted stream ended without final record'), {
                operation: 'crypto.missingFinalRecord',
                level: 'warning',
                extra: { recordCount, eceVersion },
            });
        },
    });
}

/**
 * Decrypt a single record using AES-GCM
 */
async function decryptRecord(
    key: CryptoKey,
    data: Uint8Array,
    counter: number,
): Promise<{ data: Uint8Array; isFinal: boolean }> {
    // Generate nonce from counter (try non-final first — most records are non-final)
    const nonce = new Uint8Array(NONCE_LENGTH);
    const view = new DataView(nonce.buffer);
    view.setUint32(0, counter, false);

    let decrypted: ArrayBuffer;
    let isFinal = false;

    try {
        decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH * 8 },
            key,
            data as BufferSource,
        );
    } catch {
        // Fall back to the final-record nonce variant
        const finalNonce = new Uint8Array(nonce);
        finalNonce[0] |= 0x80;
        decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: finalNonce, tagLength: TAG_LENGTH * 8 },
            key,
            data as BufferSource,
        );
        isFinal = true;
    }

    const decryptedArray = new Uint8Array(decrypted);

    // The encryptor always appends a delimiter byte (1 or 2); anything else
    // means a key/stream mismatch rather than a legitimate record.
    const delimiterIndex = decryptedArray.length - 1;
    const delimiter = decryptedArray[delimiterIndex];
    if (delimiter !== 1 && delimiter !== 2) {
        throw new Error('Invalid ECE record: missing delimiter byte');
    }

    return { data: decryptedArray.slice(0, delimiterIndex), isFinal };
}

/**
 * Calculate encrypted size from plaintext size
 */
export function calculateEncryptedSize(plaintextSize: number): number {
    // Exact record-size multiples (including 0) carry an extra empty final record
    const numRecords =
        plaintextSize % ECE_RECORD_SIZE === 0
            ? plaintextSize / ECE_RECORD_SIZE + 1
            : Math.ceil(plaintextSize / ECE_RECORD_SIZE);
    const overhead = numRecords * (TAG_LENGTH + 1); // Tag + delimiter per record
    return plaintextSize + overhead;
}
