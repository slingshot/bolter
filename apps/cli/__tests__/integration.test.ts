import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExists, getServerConfig } from '../lib/api';
import { b64ToArray, Keychain } from '../lib/crypto';
import { downloadFile } from '../lib/download-engine';
import { executeUpload } from '../lib/upload-engine';
import { parseBolterUrl } from '../lib/url';

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

// biome-ignore lint: Bun Server generic
let server: any;
let serverUrl: string;
const fileStore = new Map<string, { data: Uint8Array; metadata: any }>();

beforeAll(() => {
    server = Bun.serve({
        port: 0, // random available port
        async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname;

            // GET /config
            if (path === '/config') {
                return Response.json({
                    maxFileSize: 1_000_000_000,
                    maxExpireSeconds: 86400,
                    defaultExpireSeconds: 86400,
                    defaultDownloads: 1,
                    expireTimesSeconds: [300, 3600, 86400],
                    downloadCounts: [1, 5, 10],
                });
            }

            // GET /exists/:id
            if (path.match(/^\/exists\/(.+)$/) && req.method === 'GET') {
                const id = path.split('/')[2];
                return Response.json({ exists: fileStore.has(id) });
            }

            // POST /upload/url — generate a "presigned" URL pointing back to our mock
            if (path === '/upload/url' && req.method === 'POST') {
                const _body = await req.json();
                const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
                const owner = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
                return Response.json({
                    useSignedUrl: true,
                    multipart: false,
                    id,
                    owner,
                    url: `${serverUrl}/mock-upload/${id}`,
                });
            }

            // PUT /mock-upload/:id — store the uploaded data
            if (path.startsWith('/mock-upload/') && req.method === 'PUT') {
                const id = path.split('/')[2];
                const data = new Uint8Array(await req.arrayBuffer());
                fileStore.set(id, { data, metadata: null });
                return new Response(null, {
                    status: 200,
                    headers: { ETag: '"mock-etag"' },
                });
            }

            // POST /upload/complete
            if (path === '/upload/complete' && req.method === 'POST') {
                const body = await req.json();
                const stored = fileStore.get(body.id);
                if (stored) {
                    stored.metadata = {
                        metadata: body.metadata,
                        authKey: body.authKey,
                        encrypted: !!body.authKey,
                    };
                }
                return Response.json({ success: true, id: body.id });
            }

            // GET /metadata/:id
            if (path.match(/^\/metadata\/(.+)$/) && req.method === 'GET') {
                const id = path.split('/')[2];
                const stored = fileStore.get(id);
                if (!stored?.metadata) {
                    return Response.json({ error: 'Not found' }, { status: 404 });
                }
                return Response.json({
                    metadata: stored.metadata.metadata,
                    ttl: 86400,
                    encrypted: stored.metadata.encrypted,
                });
            }

            // GET /download/url/:id
            if (path.match(/^\/download\/url\/(.+)$/)) {
                const id = path.split('/')[3];
                return Response.json({
                    useSignedUrl: true,
                    url: `${serverUrl}/mock-download/${id}`,
                    dl: 0,
                    dlimit: 10,
                });
            }

            // GET /mock-download/:id
            if (path.startsWith('/mock-download/')) {
                const id = path.split('/')[2];
                const stored = fileStore.get(id);
                if (!stored) {
                    return new Response('Not found', { status: 404 });
                }
                return new Response(stored.data as unknown as BodyInit);
            }

            // POST /download/complete/:id
            if (path.match(/^\/download\/complete\/(.+)$/)) {
                return Response.json({ deleted: false, dl: 1, dlimit: 10 });
            }

            return new Response('Not found', { status: 404 });
        },
    });
    serverUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
    server.stop();
});

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
    for (const dir of tempDirs) {
        try {
            await rm(dir, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    }
    tempDirs.length = 0;
});

/** Create a temp directory for test files. */
async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bolter-integ-test-'));
    tempDirs.push(dir);
    return dir;
}

/** Compute SHA-256 hex hash of a Uint8Array or Buffer. */
function sha256hex(data: Uint8Array | Buffer): string {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(data);
    return hasher.digest('hex');
}

// ---------------------------------------------------------------------------
// Tests: Unencrypted upload + download
// ---------------------------------------------------------------------------

describe('unencrypted upload + download', () => {
    test('upload and download a small file with SHA256 match', async () => {
        const dir = await makeTempDir();
        const inputPath = join(dir, 'test-file.bin');
        const plaintext = crypto.getRandomValues(new Uint8Array(1024));
        await Bun.write(inputPath, plaintext);

        const keychain = new Keychain(); // keychain is required but unused for unencrypted
        const result = await executeUpload({
            filePath: inputPath,
            fileName: 'test-file.bin',
            fileSize: plaintext.length,
            fileMtime: Date.now(),
            encrypted: false,
            keychain,
            timeLimit: 86400,
            downloadLimit: 10,
            server: serverUrl,
            noResume: true,
        });

        expect(result.id).toBeTruthy();
        expect(result.size).toBe(plaintext.length);

        // Download the file
        const outputPath = join(dir, 'downloaded.bin');
        const dlResult = await downloadFile({
            url: result.id,
            outputPath,
            serverOverride: serverUrl,
        });

        expect(dlResult.fileName).toBe('test-file.bin');
        expect(dlResult.fileSize).toBe(plaintext.length);
        expect(dlResult.encrypted).toBe(false);

        // Compare SHA256
        const downloaded = await Bun.file(outputPath).arrayBuffer();
        expect(sha256hex(new Uint8Array(downloaded))).toBe(sha256hex(plaintext));
    });

    test('metadata contains correct files array with name and size', async () => {
        const dir = await makeTempDir();
        const inputPath = join(dir, 'meta-test.txt');
        const content = new TextEncoder().encode('hello metadata');
        await Bun.write(inputPath, content);

        const keychain = new Keychain();
        const result = await executeUpload({
            filePath: inputPath,
            fileName: 'meta-test.txt',
            fileSize: content.length,
            fileMtime: Date.now(),
            encrypted: false,
            keychain,
            timeLimit: 86400,
            downloadLimit: 5,
            server: serverUrl,
            noResume: true,
        });

        // Read stored metadata from mock server
        const stored = fileStore.get(result.id);
        expect(stored).toBeTruthy();
        expect(stored?.metadata.encrypted).toBe(false);

        // Metadata is base64-encoded JSON (unencrypted path)
        const decoded = JSON.parse(new TextDecoder().decode(b64ToArray(stored?.metadata.metadata)));
        expect(decoded.files).toBeArrayOfSize(1);
        expect(decoded.files[0].name).toBe('meta-test.txt');
        expect(decoded.files[0].size).toBe(content.length);
    });
});

// ---------------------------------------------------------------------------
// Tests: Encrypted upload + download
// ---------------------------------------------------------------------------

describe('encrypted upload + download', () => {
    test('upload encrypted and download with SHA256 match', async () => {
        const dir = await makeTempDir();
        const inputPath = join(dir, 'secret.bin');
        const plaintext = crypto.getRandomValues(new Uint8Array(1024));
        await Bun.write(inputPath, plaintext);

        const keychain = new Keychain();
        const result = await executeUpload({
            filePath: inputPath,
            fileName: 'secret.bin',
            fileSize: plaintext.length,
            fileMtime: Date.now(),
            encrypted: true,
            keychain,
            timeLimit: 86400,
            downloadLimit: 10,
            server: serverUrl,
            noResume: true,
        });

        expect(result.id).toBeTruthy();
        // Encrypted size is larger due to ECE overhead
        expect(result.size).toBeGreaterThan(plaintext.length);

        // Download with the same keychain's secret key
        const outputPath = join(dir, 'decrypted.bin');
        const secretKeyB64 = keychain.secretKeyB64;
        const downloadUrl = `${serverUrl}/download/${result.id}#${secretKeyB64}`;

        const dlResult = await downloadFile({
            url: downloadUrl,
            outputPath,
            serverOverride: serverUrl,
        });

        expect(dlResult.encrypted).toBe(true);

        // Compare SHA256 of original plaintext vs decrypted output
        const downloaded = await Bun.file(outputPath).arrayBuffer();
        expect(sha256hex(new Uint8Array(downloaded))).toBe(sha256hex(plaintext));
    });

    test('encrypted data stored on server differs from plaintext', async () => {
        const dir = await makeTempDir();
        const inputPath = join(dir, 'differ.bin');
        const plaintext = crypto.getRandomValues(new Uint8Array(512));
        await Bun.write(inputPath, plaintext);

        const keychain = new Keychain();
        const result = await executeUpload({
            filePath: inputPath,
            fileName: 'differ.bin',
            fileSize: plaintext.length,
            fileMtime: Date.now(),
            encrypted: true,
            keychain,
            timeLimit: 86400,
            downloadLimit: 10,
            server: serverUrl,
            noResume: true,
        });

        const stored = fileStore.get(result.id);
        expect(stored).toBeTruthy();

        // The raw bytes on the "server" must not match the plaintext
        const storedData = stored!.data;
        expect(sha256hex(storedData)).not.toBe(sha256hex(plaintext));
        expect(storedData.length).toBeGreaterThan(plaintext.length);
    });

    test('encrypted metadata is not readable without key', async () => {
        const dir = await makeTempDir();
        const inputPath = join(dir, 'enc-meta.txt');
        const content = new TextEncoder().encode('encrypted metadata test');
        await Bun.write(inputPath, content);

        const keychain = new Keychain();
        const result = await executeUpload({
            filePath: inputPath,
            fileName: 'enc-meta.txt',
            fileSize: content.length,
            fileMtime: Date.now(),
            encrypted: true,
            keychain,
            timeLimit: 86400,
            downloadLimit: 5,
            server: serverUrl,
            noResume: true,
        });

        // Get the stored item by its known ID
        const stored = fileStore.get(result.id);
        expect(stored).toBeTruthy();
        expect(stored?.metadata.encrypted).toBe(true);
        const metadataStr = stored?.metadata.metadata;

        // Attempting to decode the metadata as plain base64 JSON should fail
        // because it's encrypted ciphertext
        const rawBytes = b64ToArray(metadataStr);
        let parsedAsPlaintext = false;
        try {
            const text = new TextDecoder().decode(rawBytes);
            const parsed = JSON.parse(text);
            // If we somehow got valid JSON with a files array, it wasn't encrypted
            if (parsed.files) {
                parsedAsPlaintext = true;
            }
        } catch {
            // Expected — ciphertext is not valid JSON
        }
        expect(parsedAsPlaintext).toBe(false);

        // But the original keychain can decrypt it
        const decrypted = await keychain.decryptMetadata(rawBytes);
        expect(decrypted).toHaveProperty('files');
    });
});

// ---------------------------------------------------------------------------
// Tests: Metadata format
// ---------------------------------------------------------------------------

describe('metadata format', () => {
    test('unencrypted metadata is base64-encoded JSON with files array', async () => {
        const dir = await makeTempDir();
        const inputPath = join(dir, 'fmt.dat');
        const content = crypto.getRandomValues(new Uint8Array(256));
        await Bun.write(inputPath, content);

        const keychain = new Keychain();
        const result = await executeUpload({
            filePath: inputPath,
            fileName: 'fmt.dat',
            fileSize: content.length,
            fileMtime: Date.now(),
            encrypted: false,
            keychain,
            timeLimit: 3600,
            downloadLimit: 1,
            server: serverUrl,
            noResume: true,
        });

        const stored = fileStore.get(result.id);
        expect(stored).toBeTruthy();

        // Decode the base64 metadata
        const rawBytes = b64ToArray(stored?.metadata.metadata);
        const decoded = JSON.parse(new TextDecoder().decode(rawBytes));

        expect(decoded).toHaveProperty('files');
        expect(Array.isArray(decoded.files)).toBe(true);
        expect(decoded.files[0]).toEqual({
            name: 'fmt.dat',
            size: content.length,
            type: 'application/octet-stream',
        });
    });

    test('encrypted metadata is decryptable with same keychain', async () => {
        const dir = await makeTempDir();
        const inputPath = join(dir, 'enc-fmt.dat');
        const content = crypto.getRandomValues(new Uint8Array(128));
        await Bun.write(inputPath, content);

        const keychain = new Keychain();
        const result = await executeUpload({
            filePath: inputPath,
            fileName: 'enc-fmt.dat',
            fileSize: content.length,
            fileMtime: Date.now(),
            encrypted: true,
            keychain,
            timeLimit: 3600,
            downloadLimit: 1,
            server: serverUrl,
            noResume: true,
        });

        const stored = fileStore.get(result.id);
        expect(stored).toBeTruthy();

        const rawBytes = b64ToArray(stored?.metadata.metadata);
        const decrypted = (await keychain.decryptMetadata(rawBytes)) as {
            files: { name: string; size: number; type: string }[];
        };

        expect(decrypted.files).toBeArrayOfSize(1);
        expect(decrypted.files[0].name).toBe('enc-fmt.dat');
        expect(decrypted.files[0].size).toBe(content.length);
    });
});

// ---------------------------------------------------------------------------
// Tests: API client functions
// ---------------------------------------------------------------------------

describe('API client functions', () => {
    test('getServerConfig returns valid config', async () => {
        const config = await getServerConfig(serverUrl);
        expect(config.maxFileSize).toBe(1_000_000_000);
        expect(config.defaultExpireSeconds).toBe(86400);
        expect(config.expireTimesSeconds).toBeArray();
        expect(config.downloadCounts).toBeArray();
        expect(config.downloadCounts).toContain(1);
        expect(config.downloadCounts).toContain(5);
        expect(config.downloadCounts).toContain(10);
    });

    test('checkExists returns true for uploaded file', async () => {
        const dir = await makeTempDir();
        const inputPath = join(dir, 'exists-test.txt');
        await Bun.write(inputPath, 'check if I exist');

        const keychain = new Keychain();
        const result = await executeUpload({
            filePath: inputPath,
            fileName: 'exists-test.txt',
            fileSize: 16,
            fileMtime: Date.now(),
            encrypted: false,
            keychain,
            timeLimit: 86400,
            downloadLimit: 1,
            server: serverUrl,
            noResume: true,
        });

        const exists = await checkExists(serverUrl, result.id);
        expect(exists).toBe(true);
    });

    test('checkExists returns false for random ID', async () => {
        const exists = await checkExists(serverUrl, 'nonexistent-id-12345');
        expect(exists).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Tests: URL parsing integration
// ---------------------------------------------------------------------------

describe('URL parsing integration', () => {
    test('parses mock server download URL with secret key', () => {
        const id = 'abc123def456';
        const key = 'mySecretKey_base64-safe';
        const url = `${serverUrl}/download/${id}#${key}`;
        const parsed = parseBolterUrl(url);
        expect(parsed.fileId).toBe(id);
        expect(parsed.secretKey).toBe(key);
    });
});
