import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISCOVERY_VERSION, PROTOCOL_VERSION } from '@bolter/protocol';
import { toEntry } from '../src/commands/ls';
import { performResume } from '../src/commands/resume';
import { performUpload } from '../src/commands/up';
import { createSession } from '../src/core/session';
import { openState } from '../src/state/db';

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let home: string;
let root: string;

let stored: Map<number, Uint8Array>;
let completions: Array<Record<string, unknown>>;
let partSize: number;
/** Part number after which every further PUT fails, simulating a crash. */
let dieAfterPart: number;
let allocations: number;
let resumeCalls: Array<number[]>;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        maxRequestBodySize: 512 * 1024 * 1024,
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
                    features: ['multipart', 'resume'],
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

            if (pathname === '/upload/url') {
                allocations++;
                const body = (await request.json()) as { fileSize: number };
                const numParts = Math.ceil(body.fileSize / partSize);
                return Response.json({
                    useSignedUrl: true,
                    multipart: body.fileSize > partSize,
                    id: 'file-1',
                    owner: 'owner-token',
                    uploadToken: 'upload-token',
                    uploadId: 'mp-1',
                    // The single-part path uses this instead of `parts`.
                    url: `${origin}/store?part=1`,
                    partSize,
                    parts: Array.from({ length: numParts }, (_, i) => ({
                        partNumber: i + 1,
                        url: `${origin}/store?part=${i + 1}`,
                        minSize: 0,
                        maxSize: partSize,
                    })),
                });
            }

            if (pathname === '/upload/multipart/file-1/resume') {
                const body = (await request.json()) as { completedPartNumbers: number[] };
                resumeCalls.push(body.completedPartNumbers);
                const total = totalParts();
                const done = new Set(body.completedPartNumbers);
                return Response.json({
                    // Only the parts the server does not have, which is what
                    // makes a resume cheaper than a restart.
                    parts: Array.from({ length: total }, (_, i) => i + 1)
                        .filter((n) => !done.has(n))
                        .map((n) => ({
                            partNumber: n,
                            url: `${origin}/store?part=${n}`,
                            minSize: 0,
                            maxSize: partSize,
                        })),
                    partSize,
                    numParts: total,
                });
            }

            if (pathname === '/store' && request.method === 'PUT') {
                const part = Number(url.searchParams.get('part'));
                const bytes = new Uint8Array(await request.arrayBuffer());
                if (dieAfterPart > 0 && part > dieAfterPart) {
                    // 400 rather than 500: a retryable status would spend eight
                    // exponential backoffs before giving up, and what this test
                    // simulates is a crash, not a flaky link.
                    return new Response('gone', { status: 400 });
                }
                stored.set(part, bytes);
                return new Response(null, {
                    status: 200,
                    headers: { ETag: `"etag-${part}"` },
                });
            }

            if (pathname === '/upload/complete') {
                completions.push((await request.json()) as Record<string, unknown>);
                return Response.json({
                    success: true,
                    id: 'file-1',
                    url: `${origin}/download/file-1`,
                    ttl: 86400,
                    expiresAt: Date.now() + 86400_000,
                });
            }

            return new Response('not found', { status: 404 });
        },
    });
    origin = `http://localhost:${server.port}`;
});

afterAll(() => {
    server.stop(true);
});

const FILE_SIZE = 16_000_000;
function totalParts(): number {
    return Math.ceil(FILE_SIZE / partSize);
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sendfm-resume-'));
    home = mkdtempSync(join(tmpdir(), 'sendfm-resume-home-'));
    stored = new Map();
    completions = [];
    resumeCalls = [];
    partSize = 5_242_880;
    dieAfterPart = 0;
    allocations = 0;
});

afterEach(() => {
    openState({ SENDFM_STATE_DIR: home } as NodeJS.ProcessEnv).close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

function env() {
    return { SENDFM_CONFIG_DIR: home, SENDFM_STATE_DIR: home } as NodeJS.ProcessEnv;
}

function session(flags: Record<string, unknown> = {}) {
    return createSession({
        name: 'up',
        flags: { instance: origin, quiet: true, ...flags },
        env: env(),
        write: () => undefined,
    });
}

function makeFile(name: string, size: number): string {
    const path = join(root, name);
    writeFileSync(
        path,
        Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251),
    );
    return path;
}

function assembled(): Uint8Array {
    const numbers = [...stored.keys()].sort((a, b) => a - b);
    return Buffer.concat(numbers.map((n) => Buffer.from(stored.get(n) as Uint8Array)));
}

describe('history', () => {
    it('records a completed upload so it can be listed and re-shared', async () => {
        const path = makeFile('a.bin', 1000);
        const data = await performUpload(session(), [path], {});
        const record = openState(env()).get(data.id);
        expect(record?.status).toBe('complete');
        expect(record?.name).toBe('a.bin');
        expect(record?.ownerToken).toBe('owner-token');
    });

    it('stores the secret so a link can be reprinted', async () => {
        const path = makeFile('a.bin', 1000);
        const data = await performUpload(session(), [path], { encrypt: true });
        expect(openState(env()).get(data.id)?.secret).toBe(data.secret as string);
    });

    it('honours storeSecrets: false', async () => {
        writeFileSync(join(home, 'config.json'), JSON.stringify({ storeSecrets: false }));
        const path = makeFile('a.bin', 1000);
        const data = await performUpload(session(), [path], { encrypt: true });
        // The link still works — it was printed — but nothing about the key
        // was written to disk.
        expect(openState(env()).get(data.id)?.secret).toBeNull();
    });
});

/**
 * `data.url` is what an agent reading `--json` will hand to a person. For an
 * encrypted send the key lives in the fragment, so a `url` without it is a link
 * that resolves to ciphertext nobody can open — broken in a way that looks
 * fine. The field therefore always carries the complete, ready-to-share link,
 * and `secret` remains alongside it for callers that want the key by itself.
 */
describe('share link in the JSON envelope', () => {
    it('carries the key in the url for an encrypted send', async () => {
        const path = makeFile('a.bin', 1000);
        const data = await performUpload(session(), [path], { encrypt: true });
        expect(data.secret).toBeTruthy();
        // The state DB keeps the bare url; the envelope adds the fragment. That
        // split is deliberate — the key is stored in its own column.
        const stored = openState(env()).get(data.id)?.url as string;
        expect(stored).not.toContain('#');
        expect(data.url).toBe(`${stored}#${data.secret}`);
    });

    it('leaves an unencrypted url without a fragment', async () => {
        const path = makeFile('a.bin', 1000);
        const data = await performUpload(session(), [path], {});
        expect(data.url).not.toContain('#');
        expect(data.secret).toBeUndefined();
    });

    it('is complete when `ls` reprints it from history', async () => {
        const path = makeFile('a.bin', 1000);
        const data = await performUpload(session(), [path], { encrypt: true });
        const record = openState(env()).get(data.id) as NonNullable<
            ReturnType<ReturnType<typeof openState>['get']>
        >;
        expect(toEntry(record, Date.now()).url).toBe(data.url);
    });

    it('reports no link at all when the key was never kept', async () => {
        // A bare link to an encrypted file resolves to ciphertext nobody can
        // open, so null is the honest answer.
        writeFileSync(join(home, 'config.json'), JSON.stringify({ storeSecrets: false }));
        const path = makeFile('a.bin', 1000);
        const data = await performUpload(session(), [path], { encrypt: true });
        const record = openState(env()).get(data.id) as NonNullable<
            ReturnType<ReturnType<typeof openState>['get']>
        >;
        expect(toEntry(record, Date.now()).url).toBeNull();
    });

    it('is complete after a resume too', async () => {
        // The resume path builds its own result, so it can drift from `up`.
        // 6 MiB parts, because 5 MiB of ciphertext aligns down to a
        // non-trailing part below what storage accepts.
        partSize = 6 * 1024 * 1024;
        const path = makeFile('big.bin', FILE_SIZE);
        dieAfterPart = 1;
        await performUpload(session(), [path], { encrypt: true }).catch(() => undefined);
        dieAfterPart = 0;
        const result = await performResume(session(), openState(env()).pending()[0]);
        expect(result.secret).toBeTruthy();
        expect(result.url.endsWith(`#${result.secret}`)).toBe(true);
    });
});

describe('resume', () => {
    it('finishes an upload that died partway, without re-sending stored parts', async () => {
        const path = makeFile('big.bin', FILE_SIZE);
        dieAfterPart = 1;

        await expect(performUpload(session(), [path], {})).rejects.toThrow();
        const storedAfterCrash = new Set(stored.keys());
        expect(storedAfterCrash.size).toBeGreaterThan(0);
        expect(storedAfterCrash.size).toBeLessThan(totalParts());
        expect(completions).toHaveLength(0);

        // A record survives the crash: written before any byte moved.
        const state = openState(env());
        const pending = state.pending();
        expect(pending).toHaveLength(1);
        expect(state.partsFor(pending[0].id).length).toBe(storedAfterCrash.size);

        dieAfterPart = 0;
        const result = await performResume(session(), pending[0]);

        expect(result.partsAlreadyDone).toBe(storedAfterCrash.size);
        expect(result.bytesSkipped).toBeGreaterThan(0);
        // The server is told what it already has, so it only signs the rest.
        expect(resumeCalls[0].sort()).toEqual([...storedAfterCrash].sort());
        expect(assembled()).toEqual(new Uint8Array(await Bun.file(path).arrayBuffer()));
    });

    it('does not allocate a second file id', async () => {
        const path = makeFile('big.bin', FILE_SIZE);
        dieAfterPart = 1;
        await performUpload(session(), [path], {}).catch(() => undefined);
        const before = allocations;

        dieAfterPart = 0;
        const pending = openState(env()).pending();
        await performResume(session(), pending[0]);

        // Calling /upload/url again would mint a new id and orphan everything
        // already stored.
        expect(allocations).toBe(before);
        expect(completions[0].id).toBe('file-1');
    });

    it('completes with every part, including the ones it did not send', async () => {
        const path = makeFile('big.bin', FILE_SIZE);
        dieAfterPart = 1;
        await performUpload(session(), [path], {}).catch(() => undefined);
        dieAfterPart = 0;
        await performResume(session(), openState(env()).pending()[0]);

        const parts = completions[0].parts as Array<{ PartNumber: number }>;
        expect(parts.map((p) => p.PartNumber)).toEqual(
            Array.from({ length: totalParts() }, (_, i) => i + 1),
        );
    });

    it('marks the record complete, so it stops being pending', async () => {
        const path = makeFile('big.bin', FILE_SIZE);
        dieAfterPart = 1;
        await performUpload(session(), [path], {}).catch(() => undefined);
        dieAfterPart = 0;
        const state = openState(env());
        await performResume(session(), state.pending()[0]);
        expect(state.pending()).toHaveLength(0);
    });

    it('refuses when the source changed size', async () => {
        const path = makeFile('big.bin', FILE_SIZE);
        dieAfterPart = 1;
        await performUpload(session(), [path], {}).catch(() => undefined);
        dieAfterPart = 0;

        // Different bytes would produce parts that do not match the stored
        // ones: an object that assembles cleanly and decodes to garbage.
        writeFileSync(path, new Uint8Array(500));
        await expect(performResume(session(), openState(env()).pending()[0])).rejects.toThrow(
            /when the upload started/,
        );
    });

    it('refuses when the source is gone', async () => {
        const path = makeFile('big.bin', FILE_SIZE);
        dieAfterPart = 1;
        await performUpload(session(), [path], {}).catch(() => undefined);
        dieAfterPart = 0;
        rmSync(path);
        await expect(performResume(session(), openState(env()).pending()[0])).rejects.toThrow(
            /is gone/,
        );
    });

    it('refuses an encrypted resume whose key was not stored', async () => {
        writeFileSync(join(home, 'config.json'), JSON.stringify({ storeSecrets: false }));
        const path = makeFile('big.bin', FILE_SIZE);
        dieAfterPart = 1;
        await performUpload(session(), [path], { encrypt: true }).catch(() => undefined);
        dieAfterPart = 0;
        // Encrypting the rest under a fresh key would make the whole object
        // undecryptable, so this has to fail rather than proceed.
        await expect(performResume(session(), openState(env()).pending()[0])).rejects.toThrow(
            /key was not stored/,
        );
    });
});
