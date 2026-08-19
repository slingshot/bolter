/**
 * The metadata blob: what a share carries about its contents.
 *
 * For an encrypted share this is AES-GCM ciphertext under a key the server
 * never sees, so the server cannot inspect, validate or repair it — which is
 * why the encoding is pinned here rather than left to each client.
 */

import { arrayToB64, b64ToArray, ECE_VERSION, type Keychain } from './crypto';

export interface MetadataFileEntry {
    name: string;
    size: number;
    type: string;
}

export interface UploadMetadata {
    files: MetadataFileEntry[];
    /** True when several files were archived into one object at upload time. */
    zipped?: boolean;
    zipFilename?: string;
    /**
     * ECE format marker. Its absence means a pre-versioning client wrote the
     * ciphertext, which is the only case allowed to decrypt without a
     * final-flagged record — see `readEceVersion`.
     */
    eceVersion?: number;
    /** Legacy single-file shares carried these at the root. */
    name?: string;
    size?: number;
    type?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Standard base64 (not the URL-safe variant) of UTF-8 bytes.
 *
 * Deliberately different from `arrayToB64`: unencrypted shares have always
 * been encoded this way, and the two produce different strings for the same
 * input. The server normalises both, but changing what we emit would break
 * byte-for-byte comparison against everything already stored.
 */
function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function buildUploadMetadata(opts: {
    files: MetadataFileEntry[];
    encrypted: boolean;
    zipFilename?: string;
}): UploadMetadata {
    const metadata: UploadMetadata = {
        files: opts.files.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type || 'application/octet-stream',
        })),
        ...(opts.encrypted && { eceVersion: ECE_VERSION }),
    };
    if (opts.files.length > 1 && opts.zipFilename) {
        metadata.zipped = true;
        metadata.zipFilename = opts.zipFilename;
    }
    return metadata;
}

/** Encode for `/upload/complete`. Encrypted blobs are base64url ciphertext. */
export async function encodeMetadata(
    metadata: UploadMetadata,
    keychain: Keychain | null,
): Promise<string> {
    if (keychain) {
        return arrayToB64(await keychain.encryptMetadata(metadata));
    }
    return bytesToBase64(encoder.encode(JSON.stringify(metadata)));
}

/** Decode what `/metadata/:id` returns. */
export async function decodeMetadata(
    raw: string,
    keychain: Keychain | null,
): Promise<UploadMetadata> {
    if (keychain) {
        return (await keychain.decryptMetadata(b64ToArray(raw))) as UploadMetadata;
    }
    return JSON.parse(decoder.decode(b64ToArray(raw))) as UploadMetadata;
}

/**
 * The name/size/type a client shows for a share, flattened from whichever
 * shape the metadata uses — multi-file, zipped, or a legacy root-level single
 * file.
 */
export function describeMetadata(metadata: UploadMetadata): MetadataFileEntry {
    const first = metadata.files?.[0];
    if (metadata.zipped && metadata.zipFilename) {
        return {
            name: metadata.zipFilename,
            size: metadata.size ?? 0,
            type: 'application/zip',
        };
    }
    return {
        name: first?.name || metadata.name || 'download',
        size: first?.size ?? metadata.size ?? 0,
        type: first?.type || metadata.type || 'application/octet-stream',
    };
}
