/**
 * Crypto utilities for client-side encryption
 * Uses Web Crypto API for AES-GCM encryption and HKDF key derivation
 */

import { captureError } from './sentry';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ECE (Encrypted Content Encoding) configuration
export const ECE_RECORD_SIZE = 64 * 1024; // 64KB record size
const TAG_LENGTH = 16; // AES-GCM tag length
const NONCE_LENGTH = 12; // AES-GCM nonce length

// Key derivation info strings
const KEY_INFO = encoder.encode('Content-Encoding: aes128gcm');
const NONCE_INFO = encoder.encode('Content-Encoding: nonce');
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
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
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
  length: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    },
    key,
    length * 8
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
    if (this.encryptionKey) return this.encryptionKey;

    const salt = new Uint8Array(16);
    const keyMaterial = await hkdf(this.secretKey, salt, KEY_INFO, 16);

    this.encryptionKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'AES-GCM', length: 128 },
      false,
      ['encrypt', 'decrypt']
    );

    return this.encryptionKey;
  }

  /**
   * Derive the metadata encryption key
   */
  async getMetaKey(): Promise<CryptoKey> {
    if (this.metaKey) return this.metaKey;

    const salt = new Uint8Array(16);
    const keyMaterial = await hkdf(this.secretKey, salt, META_INFO, 16);

    this.metaKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'AES-GCM', length: 128 },
      false,
      ['encrypt', 'decrypt']
    );

    return this.metaKey;
  }

  /**
   * Derive the authentication key
   */
  async getAuthKey(): Promise<Uint8Array> {
    if (this.authKey) return this.authKey;

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
      authKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const sig = await crypto.subtle.sign('HMAC', key, nonceBytes);
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
      data
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
      encryptedData
    );

    return JSON.parse(decoder.decode(decrypted));
  }
}

/**
 * Create encryption transform stream for file content
 */
export function createEncryptionStream(keychain: Keychain): TransformStream<Uint8Array, Uint8Array> {
  let recordCount = 0;
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
      // Encrypt final record (may be less than ECE_RECORD_SIZE)
      if (buffer.length > 0) {
        const encrypted = await encryptRecord(encryptionKey, buffer, recordCount, true);
        controller.enqueue(encrypted);
      }
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
  isFinal: boolean
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
    paddedData
  );

  return new Uint8Array(encrypted);
}

/**
 * Create decryption transform stream for file content
 */
export function createDecryptionStream(keychain: Keychain): TransformStream<Uint8Array, Uint8Array> {
  let recordCount = 0;
  let buffer = new Uint8Array(0);
  let encryptionKey: CryptoKey;
  const encryptedRecordSize = ECE_RECORD_SIZE + TAG_LENGTH + 1;

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
      while (buffer.length >= encryptedRecordSize) {
        const record = buffer.slice(0, encryptedRecordSize);
        buffer = buffer.slice(encryptedRecordSize);

        const decrypted = await decryptRecord(encryptionKey, record, recordCount);
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
          const decrypted = await decryptRecord(encryptionKey, buffer, recordCount);
          if (decrypted.length > 0) {
            controller.enqueue(decrypted);
          }
        } catch (e) {
          console.error('Failed to decrypt final record:', e);
          captureError(e, {
            operation: 'crypto.decryptRecord',
            extra: { recordCount, bufferLength: buffer.length },
          });
        }
      }
    },
  });
}

/**
 * Decrypt a single record using AES-GCM
 */
async function decryptRecord(
  key: CryptoKey,
  data: Uint8Array,
  counter: number
): Promise<Uint8Array> {
  // Generate nonce from counter (try both final and non-final)
  const nonce = new Uint8Array(NONCE_LENGTH);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, counter, false);

  let decrypted: ArrayBuffer;

  try {
    // Try with final flag
    const finalNonce = new Uint8Array(nonce);
    finalNonce[0] |= 0x80;
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: finalNonce, tagLength: TAG_LENGTH * 8 },
      key,
      data
    );
  } catch {
    // Try without final flag
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH * 8 },
      key,
      data
    );
  }

  const decryptedArray = new Uint8Array(decrypted);

  // Remove delimiter byte
  const delimiterIndex = decryptedArray.length - 1;
  if (decryptedArray[delimiterIndex] === 1 || decryptedArray[delimiterIndex] === 2) {
    return decryptedArray.slice(0, delimiterIndex);
  }

  return decryptedArray;
}

/**
 * Calculate encrypted size from plaintext size
 */
export function calculateEncryptedSize(plaintextSize: number): number {
  const numRecords = Math.ceil(plaintextSize / ECE_RECORD_SIZE) || 1;
  const overhead = numRecords * (TAG_LENGTH + 1); // Tag + delimiter per record
  return plaintextSize + overhead;
}
