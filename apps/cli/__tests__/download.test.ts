import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildUploadMetadata,
    calculateEncryptedSize,
    createEncryptionStream,
    DISCOVERY_VERSION,
    ECE_ENCRYPTED_RECORD_SIZE,
    ECE_RECORD_SIZE,
    encodeMetadata,
    Keychain,
    PROTOCOL_VERSION,
} from '@bolter/protocol';
import { performDownload, resolveDestination } from '../src/commands/get';
import { createSession } from '../src/core/session';
import { planRanges } from '../src/transfer/download';

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let configHome: string;
let root: string;

/** The single object the stub serves, and how it behaves. */
let object: Uint8Array<ArrayBuffer>;
let objectMetadata: string;
let objectEncrypted: boolean;
let objectFiles: Array<{ name: string; size: number; type: string }>;
let dl: number;
let dlimit: number;
let completes: number;
let ignoreRangeOnce: boolean;
let failRangeOnce: boolean;
/** Secret of the most recently published encrypted object. */
let lastSecret = '';

beforeAll(() => {
    configHome = mkdtempSync(join(tmpdir(), 'sendfm-dl-cfg-'));
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            const { pathname } = url;

            if (pathname === '/instance.json') {
                return Response.json({
                    bolter: DISCOVERY_VERSION,
                    name: 'Stub',
                    web: origin,
                    api: origin,
                    protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION },
                    features: [],
                    limits: {
                        maxFileSize: 1e9,
                        maxFilesPerArchive: 100,
                        maxExpireSeconds: 1e6,
                        maxDownloads: 100,
                        multipartThreshold: 1e8,
                        minPartSize: 5_242_880,
                        maxParts: 10000,
                        maxMetadataBytes: 524288,
                    },
                    defaults: { expireSeconds: 86400, downloads: 1 },
                });
            }

            if (pathname === '/metadata/obj') {
                return Response.json({
                    metadata: objectMetadata,
                    ttl: 3600,
                    encrypted: objectEncrypted,
                    dl,
                    dlimit,
                    size: object.length,
                });
            }

            if (pathname === '/download/url/obj') {
                if (dl >= dlimit) {
                    return Response.json({ useSignedUrl: false, dl, dlimit });
                }
                return Response.json({ useSignedUrl: true, url: `${origin}/blob`, dl, dlimit });
            }

            if (pathname === '/download/complete/obj') {
                completes++;
                dl++;
                return Response.json({ deleted: false, dl, dlimit });
            }

            if (pathname === '/blob') {
                if (failRangeOnce) {
                    failRangeOnce = false;
                    return new Response('boom', { status: 500 });
                }
                const header = request.headers.get('range');
                if (!header || ignoreRangeOnce) {
                    ignoreRangeOnce = false;
                    // A server that ignores Range answers 200 with everything.
                    return new Response(object, { status: 200 });
                }
                const match = /bytes=(\d+)-(\d+)/.exec(header);
                if (!match) {
                    return new Response('bad range', { status: 400 });
                }
                const start = Number(match[1]);
                const end = Number(match[2]) + 1;
                return new Response(object.slice(start, end), {
                    status: 206,
                    headers: {
                        'Content-Range': `bytes ${start}-${end - 1}/${object.length}`,
                    },
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
    root = mkdtempSync(join(tmpdir(), 'sendfm-dl-'));
    dl = 0;
    dlimit = 3;
    completes = 0;
    ignoreRangeOnce = false;
    failRangeOnce = false;
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const pattern = (n: number): Uint8Array<ArrayBuffer> =>
    Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 251);

async function publishPlain(name: string, size: number): Promise<Uint8Array<ArrayBuffer>> {
    const plain = pattern(size);
    object = plain;
    objectEncrypted = false;
    objectFiles = [{ name, size, type: 'application/octet-stream' }];
    objectMetadata = await encodeMetadata(
        buildUploadMetadata({ files: objectFiles, encrypted: false }),
        null,
    );
    return plain;
}

async function publishEncrypted(
    name: string,
    size: number,
): Promise<{ plain: Uint8Array<ArrayBuffer>; secret: string }> {
    const keychain = new Keychain();
    const plain = pattern(size);
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(plain);
            controller.close();
        },
    }).pipeThrough(createEncryptionStream(keychain));
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    const joined = Buffer.concat(chunks.map(Buffer.from));
    object = new Uint8Array(
        joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength),
    );
    objectEncrypted = true;
    objectFiles = [{ name, size, type: 'application/octet-stream' }];
    objectMetadata = await encodeMetadata(
        buildUploadMetadata({ files: objectFiles, encrypted: true }),
        keychain,
    );
    lastSecret = keychain.secretKeyB64;
    return { plain, secret: lastSecret };
}

function session(flags: Record<string, unknown> = {}) {
    return createSession({
        name: 'get',
        flags: { instance: origin, quiet: true, ...flags },
        env: { SENDFM_CONFIG_DIR: configHome } as NodeJS.ProcessEnv,
        write: () => undefined,
    });
}

describe('planRanges', () => {
    it('covers the object with no gaps or overlaps', () => {
        const ranges = planRanges(30_000_000, false);
        expect(ranges[0].start).toBe(0);
        expect(ranges[ranges.length - 1].end).toBe(30_000_000);
        for (let i = 1; i < ranges.length; i++) {
            expect(ranges[i].start).toBe(ranges[i - 1].end);
        }
    });

    it('aligns encrypted ranges to whole ECE records', () => {
        // Alignment is what makes each range independently decryptable.
        const ranges = planRanges(calculateEncryptedSize(50_000_000), true);
        for (const range of ranges) {
            expect(range.start % ECE_ENCRYPTED_RECORD_SIZE).toBe(0);
            expect(range.outputOffset % ECE_RECORD_SIZE).toBe(0);
        }
    });

    it('marks only the final range as last', () => {
        const ranges = planRanges(30_000_000, false);
        expect(ranges.filter((r) => r.last)).toHaveLength(1);
        expect(ranges[ranges.length - 1].last).toBe(true);
    });

    it('produces nothing for an empty object', () => {
        expect(planRanges(0, false)).toEqual([]);
    });
});

describe('plain download', () => {
    it('writes the object byte-for-byte', async () => {
        const plain = await publishPlain('data.bin', 20_000_000);
        const data = await performDownload(session(), `${origin}/download/obj`, {
            out: root,
        });
        expect(Uint8Array.from(readFileSync(data.path))).toEqual(plain);
        expect(data.ranges).toBeGreaterThan(1);
    });

    it('spends the download only after the file is on disk', async () => {
        await publishPlain('data.bin', 1000);
        expect(completes).toBe(0);
        const data = await performDownload(session(), `${origin}/download/obj`, { out: root });
        expect(completes).toBe(1);
        expect(readFileSync(data.path).length).toBe(1000);
    });

    it('leaves no .part file behind', async () => {
        await publishPlain('data.bin', 5000);
        const data = await performDownload(session(), `${origin}/download/obj`, { out: root });
        expect(await Bun.file(`${data.path}.part`).exists()).toBe(false);
    });
});

describe('encrypted download', () => {
    it('decrypts ranges independently and reassembles the original', async () => {
        // Several ranges, each decrypted from its own record counter — the
        // property that lets a download run in parallel at all.
        const { plain } = await publishEncrypted('secret.bin', 20_000_000);
        const data = await performDownload(session(), `${origin}/download/obj#${lastSecret}`, {
            out: root,
        });
        expect(data.ranges).toBeGreaterThan(1);
        expect(Uint8Array.from(readFileSync(data.path))).toEqual(plain);
    });

    it('handles a payload smaller than one record', async () => {
        const { plain } = await publishEncrypted('tiny.bin', 100);
        const data = await performDownload(session(), `${origin}/download/obj#${lastSecret}`, {
            out: root,
        });
        expect(Uint8Array.from(readFileSync(data.path))).toEqual(plain);
    });
});

describe('failure handling', () => {
    it('refuses to write when the server ignores Range', async () => {
        // A 200 means the whole object is coming; writing it at a range's
        // offset would corrupt the file.
        await publishPlain('data.bin', 20_000_000);
        ignoreRangeOnce = true;
        await expect(
            performDownload(session(), `${origin}/download/obj`, { out: root }),
        ).rejects.toThrow(/ignored a Range request/);
        expect(completes).toBe(0);
    });

    it('retries a failed range and still writes the right bytes', async () => {
        const plain = await publishPlain('data.bin', 20_000_000);
        failRangeOnce = true;
        const data = await performDownload(session(), `${origin}/download/obj`, { out: root });
        expect(data.retries).toBeGreaterThan(0);
        expect(Uint8Array.from(readFileSync(data.path))).toEqual(plain);
    });

    it('does not spend a download when the transfer fails', async () => {
        await publishPlain('data.bin', 20_000_000);
        ignoreRangeOnce = true;
        await performDownload(session(), `${origin}/download/obj`, { out: root }).catch(
            () => undefined,
        );
        // The counter is the scarce resource; a failed save must never cost one.
        expect(completes).toBe(0);
    });

    it('refuses to overwrite without --force', async () => {
        await publishPlain('data.bin', 100);
        writeFileSync(join(root, 'data.bin'), 'existing');
        await expect(
            performDownload(session(), `${origin}/download/obj`, { out: root }),
        ).rejects.toThrow(/already exists/);
    });

    it('reports a used-up link as gone rather than as a network problem', async () => {
        await publishPlain('data.bin', 100);
        dl = 3;
        dlimit = 3;
        await expect(
            performDownload(session(), `${origin}/download/obj`, { out: root }),
        ).rejects.toThrow(/used up its downloads|no longer available/);
    });
});

describe('resolveDestination', () => {
    it('treats an existing directory as "into here"', async () => {
        expect(await resolveDestination(root, 'a.bin')).toBe(join(root, 'a.bin'));
    });

    it('treats anything else as "as this"', async () => {
        const target = join(root, 'renamed.bin');
        expect(await resolveDestination(target, 'a.bin')).toBe(target);
    });
});
