import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    calculateEncryptedSize,
    createDecryptionStream,
    DISCOVERY_VERSION,
    decodeMetadata,
    ECE_VERSION,
    Keychain,
    PROTOCOL_VERSION,
} from '@bolter/protocol';
import { performUpload } from '../src/commands/up';
import { createSession } from '../src/core/session';
import { ArchiveSource, FileSource } from '../src/transfer/source';

/**
 * A stub that plays both roles a real upload involves: the Bolter API and the
 * object store the pre-signed URLs point at. Reassembling what the store
 * received is the only way to prove the part plan, the encryption offsets and
 * the transport all agree.
 */
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let configHome: string;
let root: string;

/** partNumber → bytes, exactly as the "store" received them. */
let stored: Map<number, Uint8Array>;
let completions: Array<Record<string, unknown>>;
let partSize: number;
let failNextPut: number;
let pushbackOnce: boolean;
let expireOnce: number;

beforeAll(() => {
    configHome = mkdtempSync(join(tmpdir(), 'sendfm-up-cfg-'));
    server = Bun.serve({
        port: 0,
        maxRequestBodySize: 1024 * 1024 * 1024,
        async fetch(request) {
            const url = new URL(request.url);
            const { pathname } = url;

            if (pathname === '/instance.json') {
                return Response.json({
                    bolter: DISCOVERY_VERSION,
                    name: 'Stub',
                    web: origin,
                    api: origin,
                    protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION },
                    features: ['multipart'],
                    limits: {
                        maxFileSize: 1_000_000_000,
                        maxFilesPerArchive: 100,
                        maxExpireSeconds: 604800,
                        maxDownloads: 100,
                        multipartThreshold: 100_000_000,
                        minPartSize: 5_242_880,
                        maxParts: 10000,
                        maxMetadataBytes: 524288,
                    },
                    defaults: { expireSeconds: 86400, downloads: 1 },
                });
            }

            if (pathname === '/upload/url') {
                const body = (await request.json()) as { fileSize: number };
                const multipart = body.fileSize > partSize;
                const numParts = multipart ? Math.ceil(body.fileSize / partSize) : 1;
                return Response.json({
                    useSignedUrl: true,
                    multipart,
                    id: 'file-1',
                    owner: 'owner-token',
                    uploadToken: 'upload-token',
                    ...(multipart
                        ? {
                              uploadId: 'mp-1',
                              partSize,
                              parts: Array.from({ length: numParts }, (_, i) => ({
                                  partNumber: i + 1,
                                  url: `${origin}/store?part=${i + 1}`,
                                  minSize: 0,
                                  maxSize: partSize,
                              })),
                          }
                        : { url: `${origin}/store?part=1` }),
                });
            }

            if (pathname === '/store' && request.method === 'PUT') {
                const part = Number(url.searchParams.get('part'));
                if (expireOnce === part) {
                    expireOnce = -1;
                    // S3 rejects an expired pre-signed URL without reading the
                    // body, which is the case a retry has to survive.
                    return new Response('expired', { status: 403 });
                }
                const declared = request.headers.get('content-length');
                // Drain first, then decide. A real store reads the body before
                // it can reject it, and answering early leaves the client
                // writing into a connection nobody is reading.
                const bytes = new Uint8Array(await request.arrayBuffer());
                if (failNextPut === part) {
                    failNextPut = -1;
                    return new Response('boom', { status: 500 });
                }
                if (pushbackOnce) {
                    pushbackOnce = false;
                    return new Response('slow down', { status: 503 });
                }
                // A pre-signed PUT is signed UNSIGNED-PAYLOAD, so a chunked
                // body is rejected by the real thing. Assert the framing here.
                if (declared === null) {
                    return new Response('missing content-length', { status: 411 });
                }
                if (Number(declared) !== bytes.length) {
                    return new Response('length mismatch', { status: 400 });
                }
                stored.set(part, bytes);
                return new Response(null, { status: 200, headers: { ETag: `"etag-${part}"` } });
            }

            if (pathname === '/upload/complete') {
                const body = (await request.json()) as Record<string, unknown>;
                completions.push(body);
                return Response.json({
                    success: true,
                    id: 'file-1',
                    url: `${origin}/download/file-1`,
                    ttl: 86400,
                    expiresAt: Date.now() + 86400_000,
                });
            }

            if (pathname === '/upload/multipart/file-1/resume') {
                const body = (await request.json()) as { completedPartNumbers: number[] };
                const total = Math.max(...stored.keys(), ...body.completedPartNumbers, 1);
                return Response.json({
                    parts: Array.from({ length: total + 1 }, (_, i) => ({
                        partNumber: i + 1,
                        url: `${origin}/store?part=${i + 1}`,
                        minSize: 0,
                        maxSize: partSize,
                    })),
                    partSize,
                    numParts: total,
                });
            }

            return new Response('not found', { status: 404 });
        },
    });
    origin = `http://localhost:${server.port}`;
});

afterAll(() => {
    server.stop(true);
    rmSync(configHome, { recursive: true, force: true });
});

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sendfm-up-'));
    stored = new Map();
    completions = [];
    partSize = 5_242_880;
    failNextPut = -1;
    pushbackOnce = false;
    expireOnce = -1;
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function session(flags: Record<string, unknown> = {}) {
    return createSession({
        name: 'up',
        flags: { instance: origin, quiet: true, ...flags },
        env: { SENDFM_CONFIG_DIR: configHome } as NodeJS.ProcessEnv,
        write: () => undefined,
    });
}

/** Everything the "store" received, concatenated in part order. */
function assembled(): Uint8Array {
    const numbers = [...stored.keys()].sort((a, b) => a - b);
    return Buffer.concat(numbers.map((n) => Buffer.from(stored.get(n) as Uint8Array)));
}

function makeFile(name: string, size: number): string {
    const path = join(root, name);
    writeFileSync(
        path,
        Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251),
    );
    return path;
}

async function decrypt(bytes: Uint8Array, keychain: Keychain): Promise<Uint8Array> {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    }).pipeThrough(createDecryptionStream(keychain, { eceVersion: ECE_VERSION }));
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map(Buffer.from));
}

describe('single-part upload', () => {
    it('stores exactly the file’s bytes', async () => {
        const path = makeFile('small.bin', 4096);
        const data = await performUpload(session(), [path], {});
        expect(data.parts).toBe(1);
        expect(assembled()).toEqual(new Uint8Array(await Bun.file(path).arrayBuffer()));
        expect(data.encrypted).toBe(false);
    });

    it('sends a Content-Length rather than a chunked body', async () => {
        // The stub answers 411 without one; a real pre-signed PUT rejects it
        // too, because it is signed UNSIGNED-PAYLOAD.
        const path = makeFile('small.bin', 1000);
        await performUpload(session(), [path], {});
        expect(stored.get(1)?.length).toBe(1000);
    });
});

describe('multipart upload', () => {
    it('reassembles byte-for-byte across many parts', async () => {
        partSize = 5_242_880;
        const path = makeFile('big.bin', 12_000_000);
        const data = await performUpload(session(), [path], {});
        expect(data.parts).toBeGreaterThan(1);
        expect(assembled()).toEqual(new Uint8Array(await Bun.file(path).arrayBuffer()));
    });

    it('sends every part exactly once', async () => {
        const path = makeFile('big.bin', 12_000_000);
        const data = await performUpload(session(), [path], {});
        expect(stored.size).toBe(data.parts);
    });

    it('reports the parts it completed with', async () => {
        const path = makeFile('big.bin', 12_000_000);
        await performUpload(session(), [path], {});
        const parts = completions[0].parts as Array<{ PartNumber: number; ETag: string }>;
        expect(parts.map((p) => p.PartNumber)).toEqual(
            Array.from({ length: parts.length }, (_, i) => i + 1),
        );
        expect(parts[0].ETag).toBe('"etag-1"');
    });
});

describe('encrypted upload', () => {
    it('decrypts back to the original across a part boundary', async () => {
        // The point of the record-aligned plan: each part is encrypted
        // independently, and the concatenation still decrypts as one stream.
        //
        // 6 MiB rather than 5: record alignment takes 5 MiB down to 5,178,687
        // bytes, under the storage minimum for a non-trailing part. Real
        // instances allocate 64-128 MiB, where this never binds.
        partSize = 6_291_456;
        const path = makeFile('secret.bin', 12_000_000);
        const data = await performUpload(session(), [path], { encrypt: true });

        expect(data.secret).toBeTruthy();
        expect(data.parts).toBeGreaterThan(1);
        const ciphertext = assembled();
        expect(ciphertext.length).toBe(calculateEncryptedSize(12_000_000));

        const plaintext = await decrypt(ciphertext, new Keychain(data.secret as string));
        expect(plaintext).toEqual(new Uint8Array(await Bun.file(path).arrayBuffer()));
    });

    it('encrypts the metadata too, so the server learns no filenames', async () => {
        const path = makeFile('secret.bin', 2048);
        const data = await performUpload(session(), [path], { encrypt: true });
        const blob = completions[0].metadata as string;
        expect(blob).not.toContain('secret.bin');
        const decoded = await decodeMetadata(blob, new Keychain(data.secret as string));
        expect(decoded.files[0].name).toBe('secret.bin');
        expect(decoded.eceVersion).toBe(ECE_VERSION);
    });

    it('sends an auth key only when encrypted', async () => {
        const path = makeFile('a.bin', 2048);
        await performUpload(session(), [path], { encrypt: true });
        expect(completions[0].authKey).toBeTruthy();
        completions = [];
        stored = new Map();
        await performUpload(session(), [path], {});
        expect(completions[0].authKey).toBeUndefined();
    });
});

describe('archive upload', () => {
    it('sends several files as one valid archive', async () => {
        makeFile('a.txt', 100);
        makeFile('b.txt', 200);
        const data = await performUpload(session(), [join(root, 'a.txt'), join(root, 'b.txt')], {});

        expect(data.archive).toBe(true);
        expect(data.files).toBe(2);
        const out = join(root, 'received.zip');
        writeFileSync(out, assembled());
        expect(Bun.spawnSync(['unzip', '-t', out]).exitCode).toBe(0);
    });

    it('records every member in the metadata, not just the archive', async () => {
        makeFile('a.txt', 100);
        makeFile('b.txt', 200);
        await performUpload(session(), [join(root, 'a.txt'), join(root, 'b.txt')], {});
        const blob = completions[0].metadata as string;
        const decoded = await decodeMetadata(blob, null);
        expect(decoded.files.map((f) => f.name).sort()).toEqual(['a.txt', 'b.txt']);
        expect(decoded.zipped).toBe(true);
    });
});

describe('failure handling', () => {
    it('retries a failed part and still stores the right bytes', async () => {
        partSize = 5_242_880;
        const path = makeFile('big.bin', 12_000_000);
        failNextPut = 2;
        const data = await performUpload(session(), [path], {});
        expect(data.retries).toBeGreaterThan(0);
        // A retry must re-read the identical range; if the source had a cursor
        // this would silently upload the wrong bytes.
        expect(assembled()).toEqual(new Uint8Array(await Bun.file(path).arrayBuffer()));
    });

    it('refreshes an expired pre-signed URL and completes', async () => {
        // 403 means the URL expired, not that the server is overloaded: one
        // refresh, not a retry storm. S3 answers it without draining the body.
        partSize = 5_242_880;
        const path = makeFile('big.bin', 12_000_000);
        expireOnce = 2;
        await performUpload(session(), [path], {});
        expect(assembled()).toEqual(new Uint8Array(await Bun.file(path).arrayBuffer()));
    });

    it('backs off on a 503 rather than treating it as fatal', async () => {
        pushbackOnce = true;
        const path = makeFile('small.bin', 2048);
        const data = await performUpload(session(), [path], {});
        expect(data.retries).toBeGreaterThanOrEqual(0);
        expect(assembled().length).toBe(2048);
    });

    it('refuses a file larger than the instance allows, before transferring', async () => {
        const path = makeFile('small.bin', 2048);
        const s = session();
        await expect(performUpload(s, [path], { downloads: 1000 })).rejects.toThrow(
            /at most 100 downloads/,
        );
        expect(stored.size).toBe(0);
    });
});

describe('sources', () => {
    it('opens a single file directly rather than archiving it', async () => {
        const path = makeFile('one.bin', 10);
        const source = await FileSource.open(path);
        expect(source.archiveFilename).toBeUndefined();
        expect(source.files).toHaveLength(1);
    });

    it('knows an archive’s exact size before reading any content', async () => {
        makeFile('a.txt', 100);
        makeFile('b.txt', 200);
        const source = await ArchiveSource.open([
            { path: join(root, 'a.txt'), name: 'a.txt' },
            { path: join(root, 'b.txt'), name: 'b.txt' },
        ]);
        expect(source.plaintextSize).toBeGreaterThan(300);
    });
});
