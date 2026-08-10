import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/sentry', () => ({
    captureError: vi.fn(),
    addBreadcrumb: vi.fn(),
}));

import { API_BASE_URL, downloadFile, resumeUpload } from '@/lib/api';
import {
    arrayToB64,
    b64ToArray,
    createEncryptionStream,
    ECE_ENCRYPTED_RECORD_SIZE,
    ECE_RECORD_SIZE,
    ECE_VERSION,
    Keychain,
} from '@/lib/crypto';
import type { PersistedUpload } from '@/lib/upload-state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function encryptAll(keychain: Keychain, plaintext: Uint8Array): Promise<Uint8Array> {
    const source = new Blob([plaintext as BlobPart]).stream() as ReadableStream<Uint8Array>;
    const encrypted = source.pipeThrough(createEncryptionStream(keychain));
    const chunks: Uint8Array[] = [];
    const reader = encrypted.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
        out.set(chunk, pos);
        pos += chunk.length;
    }
    return out;
}

function makeData(size: number): Uint8Array {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = i % 256;
    }
    return data;
}

// ---------------------------------------------------------------------------
// Upload side: the marker is written into the client-encrypted metadata
// ---------------------------------------------------------------------------

/** Minimal XHR fake — the resume fast path never uploads, but api.ts reads the global. */
class FakeXHR {
    static DONE = 4;
    readyState = 4;
    status = 200;
    statusText = 'OK';
    responseText = '';
    upload = { addEventListener: () => undefined };
    addEventListener() {
        /* no parts are uploaded in these tests */
    }
    getResponseHeader() {
        return null;
    }
    open() {
        /* noop */
    }
    abort() {
        /* noop */
    }
    send() {
        /* noop */
    }
}

describe('upload writes the ECE version marker', () => {
    let requests: Array<{ url: string; body: Record<string, unknown> | null }>;

    beforeEach(() => {
        requests = [];
        vi.stubGlobal('XMLHttpRequest', FakeXHR);
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit) => {
                const body = init?.body ? JSON.parse(init.body as string) : null;
                requests.push({ url: String(url), body });
                if (String(url).includes('/resume')) {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                parts: [],
                                partSize: ECE_ENCRYPTED_RECORD_SIZE * 100,
                                numParts: 2,
                            }),
                            { status: 200 },
                        ),
                    );
                }
                if (String(url).includes('/upload/complete')) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ success: true, id: 'f1', url: 'x' }), {
                            status: 200,
                        }),
                    );
                }
                return Promise.reject(new Error(`Unexpected fetch: ${url}`));
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('stamps eceVersion into the encrypted metadata sent to /upload/complete', async () => {
        const keychain = new Keychain();
        const partSize = ECE_ENCRYPTED_RECORD_SIZE * 100;
        const state: PersistedUpload = {
            version: 2,
            fileId: 'f1',
            uploadId: 'u1',
            ownerToken: 'owner',
            fileName: 'secret.bin',
            fileSize: ECE_RECORD_SIZE * 200,
            fileLastModified: 1700000000000,
            encrypted: true,
            secretKeyB64: keychain.secretKeyB64,
            partSize,
            plaintextPartSize: ECE_RECORD_SIZE * 100,
            completedParts: [
                { PartNumber: 1, ETag: '"e1"' },
                { PartNumber: 2, ETag: '"e2"' },
            ],
            totalParts: 2,
            timeLimit: 86400,
            downloadLimit: 1,
            createdAt: Date.now(),
        };
        const file = new File([new Uint8Array(1024)], 'secret.bin', {
            lastModified: 1700000000000,
        });

        await resumeUpload(file, state);

        const complete = requests.find((r) => r.url.includes('/upload/complete'));
        expect(complete).toBeDefined();
        const metadataB64 = complete?.body?.metadata as string;
        expect(metadataB64).toBeTruthy();

        // The marker must be inside the AES-GCM-authenticated metadata blob, so
        // neither the storage provider nor the metadata server can strip it.
        const decoded = (await keychain.decryptMetadata(b64ToArray(metadataB64))) as {
            eceVersion?: number;
        };
        expect(decoded.eceVersion).toBe(ECE_VERSION);
    });
});

// ---------------------------------------------------------------------------
// Download side: a boundary-truncated versioned object must fail closed
// ---------------------------------------------------------------------------

interface DownloadFixture {
    keychain: Keychain;
    body: Uint8Array;
    plaintextSize: number;
    versioned: boolean;
}

function stubDownloadFetch(fixture: DownloadFixture, seen: string[]) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            const target = String(url);
            seen.push(target);

            if (target.startsWith(`${API_BASE_URL}/metadata/`)) {
                const metadata: Record<string, unknown> = {
                    files: [
                        {
                            name: 'secret.bin',
                            size: fixture.plaintextSize,
                            type: 'application/octet-stream',
                        },
                    ],
                };
                if (fixture.versioned) {
                    metadata.eceVersion = ECE_VERSION;
                }
                const blob = await fixture.keychain.encryptMetadata(metadata);
                return new Response(
                    JSON.stringify({ metadata: arrayToB64(blob), ttl: 3600, encrypted: true }),
                    { status: 200 },
                );
            }

            if (target.startsWith(`${API_BASE_URL}/download/url/`)) {
                return new Response(
                    JSON.stringify({ useSignedUrl: true, url: 'https://s3.example.com/object' }),
                    { status: 200 },
                );
            }

            if (target.startsWith('https://s3.example.com/object')) {
                // The compromised provider serves the truncated object with a
                // Content-Length that matches what it actually sends.
                return new Response(fixture.body as BlobPart, {
                    status: 200,
                    headers: { 'Content-Length': String(fixture.body.length) },
                });
            }

            if (target.startsWith(`${API_BASE_URL}/download/complete/`)) {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }

            throw new Error(`Unexpected fetch: ${target}`);
        }),
    );
}

describe('downloadFile truncation handling for encrypted files', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fails closed when a versioned object is truncated at a record boundary', async () => {
        const keychain = new Keychain();
        const plaintext = makeData(ECE_RECORD_SIZE * 2);
        const ciphertext = await encryptAll(keychain, plaintext);

        // Drop the trailing empty final record and the last full record. Every
        // surviving record still authenticates and Content-Length matches, so
        // only the missing final record can expose the truncation.
        const truncated = ciphertext.slice(0, ECE_ENCRYPTED_RECORD_SIZE);

        const seen: string[] = [];
        stubDownloadFetch(
            { keychain, body: truncated, plaintextSize: plaintext.length, versioned: true },
            seen,
        );

        await expect(downloadFile('abc123', keychain)).rejects.toThrow(/Download stream failed/i);

        // A truncated download must not be reported as a completed download
        expect(seen.some((u) => u.includes('/download/complete/'))).toBe(false);
    });

    it('still delivers a legacy (unmarked) object with no trailing final record', async () => {
        const keychain = new Keychain();
        const plaintext = makeData(ECE_RECORD_SIZE);
        const ciphertext = await encryptAll(keychain, plaintext);

        // Pre-versioning client: exact-record-multiple plaintext, so the stored
        // object legitimately ends without a final-flagged record.
        const legacy = ciphertext.slice(0, ECE_ENCRYPTED_RECORD_SIZE);

        const seen: string[] = [];
        stubDownloadFetch(
            { keychain, body: legacy, plaintextSize: plaintext.length, versioned: false },
            seen,
        );

        const result = await downloadFile('abc123', keychain);
        expect(result.filename).toBe('secret.bin');
        expect(result.blob.size).toBe(plaintext.length);
        expect(seen.some((u) => u.includes('/download/complete/'))).toBe(true);
    });
});
