import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildUploadMetadata,
    DISCOVERY_VERSION,
    encodeMetadata,
    Keychain,
    PROTOCOL_VERSION,
} from '@bolter/protocol';
import { collectInfo, parseTarget } from '../src/commands/info';
import { EXIT } from '../src/core/errors';
import { createSession, runCommand } from '../src/core/session';

const SECRET = new Uint8Array(16).fill(7);
const keychain = new Keychain(SECRET);

let server: ReturnType<typeof Bun.serve>;
let origin: string;
/** A second, unrelated instance — the one a pasted link points at. */
let other: ReturnType<typeof Bun.serve>;
let otherOrigin: string;
let configHome: string;
let encryptedBlob: string;
let plainBlob: string;

beforeAll(async () => {
    configHome = mkdtempSync(join(tmpdir(), 'sendfm-info-'));
    encryptedBlob = await encodeMetadata(
        buildUploadMetadata({
            files: [{ name: 'report.pdf', size: 1234, type: 'application/pdf' }],
            encrypted: true,
        }),
        keychain,
    );
    plainBlob = await encodeMetadata(
        buildUploadMetadata({
            files: [
                { name: 'a.txt', size: 10, type: 'text/plain' },
                { name: 'b.txt', size: 20, type: 'text/plain' },
            ],
            encrypted: false,
            zipFilename: 'files-2.zip',
        }),
        null,
    );

    server = Bun.serve({
        port: 0,
        fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname === '/instance.json') {
                return Response.json({
                    bolter: DISCOVERY_VERSION,
                    name: 'Stub',
                    web: origin,
                    api: origin,
                    protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION },
                    features: [],
                    limits: {
                        maxFileSize: 1,
                        maxFilesPerArchive: 1,
                        maxExpireSeconds: 1,
                        maxDownloads: 1,
                        multipartThreshold: 1,
                        minPartSize: 1,
                        maxParts: 1,
                        maxMetadataBytes: 1,
                    },
                    defaults: { expireSeconds: 1, downloads: 1 },
                });
            }
            if (pathname === '/metadata/encrypted') {
                if (!request.headers.get('authorization')) {
                    return new Response(JSON.stringify({ error: 'nope' }), {
                        status: 401,
                        headers: { 'WWW-Authenticate': 'send-v1 bm9uY2U=' },
                    });
                }
                return Response.json({
                    metadata: encryptedBlob,
                    ttl: 3600,
                    encrypted: true,
                    dl: 1,
                    dlimit: 3,
                    size: 1300,
                });
            }
            if (pathname === '/metadata/plain') {
                return Response.json({
                    metadata: plainBlob,
                    ttl: 60,
                    encrypted: false,
                    dl: 0,
                    dlimit: 1,
                    size: 30,
                });
            }
            if (pathname === '/metadata/legacy') {
                // An instance predating the dl/dlimit/size fields.
                return Response.json({ metadata: plainBlob, ttl: 60, encrypted: false });
            }
            if (pathname === '/metadata/missing') {
                return new Response(JSON.stringify({ error: 'gone' }), { status: 404 });
            }
            return new Response('not found', { status: 404 });
        },
    });
    origin = `http://localhost:${server.port}`;

    other = Bun.serve({
        port: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname === '/instance.json') {
                return Response.json({
                    bolter: DISCOVERY_VERSION,
                    name: 'Other Instance',
                    web: otherOrigin,
                    api: otherOrigin,
                    protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION },
                    features: [],
                    limits: {
                        maxFileSize: 1,
                        maxFilesPerArchive: 1,
                        maxExpireSeconds: 1,
                        maxDownloads: 1,
                        multipartThreshold: 1,
                        minPartSize: 1,
                        maxParts: 1,
                        maxMetadataBytes: 1,
                    },
                    defaults: { expireSeconds: 1, downloads: 1 },
                });
            }
            if (pathname === '/metadata/elsewhere') {
                const blob = await encodeMetadata(
                    buildUploadMetadata({
                        files: [{ name: 'from-other.txt', size: 5, type: 'text/plain' }],
                        encrypted: false,
                    }),
                    null,
                );
                return Response.json({
                    metadata: blob,
                    ttl: 60,
                    encrypted: false,
                    dl: 0,
                    dlimit: 1,
                    size: 5,
                });
            }
            return new Response('not found', { status: 404 });
        },
    });
    otherOrigin = `http://localhost:${other.port}`;
});

afterAll(() => {
    other.stop(true);
    server.stop(true);
    rmSync(configHome, { recursive: true, force: true });
});

function session(flags: Record<string, unknown> = {}) {
    return createSession({
        name: 'info',
        flags: { instance: origin, ...flags },
        env: { SENDFM_CONFIG_DIR: configHome } as NodeJS.ProcessEnv,
        write: () => undefined,
    });
}

describe('parseTarget', () => {
    it('splits a full share link', () => {
        expect(parseTarget('https://send.fm/download/abc#k3y', 'https://fallback')).toEqual({
            origin: 'https://send.fm',
            id: 'abc',
            secret: 'k3y',
        });
    });

    it('accepts a bare id against the configured instance', () => {
        expect(parseTarget('abc123', 'https://send.fm')).toEqual({
            origin: 'https://send.fm',
            id: 'abc123',
            secret: '',
        });
    });

    it('accepts id#key, which is what people paste from a truncated link', () => {
        expect(parseTarget('abc123#k3y', 'https://send.fm').secret).toBe('k3y');
    });

    it('refuses something that is neither', () => {
        expect(() => parseTarget('https://send.fm/', 'https://send.fm')).toThrow(
            /not a Bolter share link/,
        );
        expect(() => parseTarget('has spaces', 'https://send.fm')).toThrow(
            /not a share link or file id/,
        );
    });
});

describe('collectInfo', () => {
    it('decrypts metadata using the key from the link', async () => {
        const data = await collectInfo(
            session(),
            `${origin}/download/encrypted#${keychain.secretKeyB64}`,
        );
        expect(data.name).toBe('report.pdf');
        expect(data.encrypted).toBe(true);
        expect(data.downloads).toEqual({ used: 1, limit: 3 });
        expect(data.size).toBe(1300);
    });

    it('names the archive for a zipped share rather than its first member', async () => {
        const data = await collectInfo(session(), `${origin}/download/plain`);
        expect(data.archive).toBe(true);
        expect(data.name).toBe('files-2.zip');
        expect(data.files).toHaveLength(2);
    });

    it('reports unknown counts against an instance predating those fields', async () => {
        const data = await collectInfo(session(), `${origin}/download/legacy`);
        expect(data.downloads).toEqual({ used: null, limit: null });
    });

    it('does not spend a download', async () => {
        // Reading metadata never increments; only /download/complete does.
        // This is what makes `info` safe against a one-download link.
        const first = await collectInfo(session(), `${origin}/download/plain`);
        const second = await collectInfo(session(), `${origin}/download/plain`);
        expect(second.downloads.used).toBe(first.downloads.used);
    });
});

describe('collectInfo failures', () => {
    it('says the key is missing rather than reporting an auth error', async () => {
        const code = await runCommand(
            {
                name: 'info',
                flags: { instance: origin, json: true },
                env: { SENDFM_CONFIG_DIR: configHome } as NodeJS.ProcessEnv,
                write: () => undefined,
            },
            async (s) => ({
                data: await collectInfo(s, `${origin}/download/encrypted`),
                render: () => undefined,
            }),
        );
        expect(code).toBe(EXIT.AUTH);
    });

    it('reports a wrong key as a key problem, not a server problem', async () => {
        const wrong = new Keychain(new Uint8Array(16).fill(9));
        const code = await runCommand(
            {
                name: 'info',
                flags: { instance: origin, json: true },
                env: { SENDFM_CONFIG_DIR: configHome } as NodeJS.ProcessEnv,
                write: () => undefined,
            },
            async (s) => ({
                data: await collectInfo(s, `${origin}/download/encrypted#${wrong.secretKeyB64}`),
                render: () => undefined,
            }),
        );
        expect(code).toBe(EXIT.AUTH);
    });

    it('maps a 404 to GONE', async () => {
        const code = await runCommand(
            {
                name: 'info',
                flags: { instance: origin, json: true },
                env: { SENDFM_CONFIG_DIR: configHome } as NodeJS.ProcessEnv,
                write: () => undefined,
            },
            async (s) => ({
                data: await collectInfo(s, `${origin}/download/missing`),
                render: () => undefined,
            }),
        );
        expect(code).toBe(EXIT.GONE);
    });
});

/**
 * A share link names the instance holding the file. Nothing else does.
 *
 * The configured default is where *this machine* sends things; it says nothing
 * about where someone else's link points. Resolving a link against the default
 * queries the wrong server, which answers a perfectly honest 404 — and the file
 * is reported gone when it is fine.
 */
describe('a link decides its own instance', () => {
    /** No `-i`: the flag is absent, so only the link can say where to look. */
    function unconfigured() {
        return createSession({
            name: 'info',
            flags: {},
            env: { SENDFM_CONFIG_DIR: configHome } as NodeJS.ProcessEnv,
            write: () => undefined,
        });
    }

    it('follows the origin in the link rather than the default', async () => {
        // The default is send.fm, which this test must never touch — reaching
        // the other stub is the proof it did not.
        const info = await collectInfo(unconfigured(), `${otherOrigin}/download/elsewhere`);
        expect(info.name).toBe('from-other.txt');
        expect(info.instance).toBe('Other Instance');
    });

    it('lets an explicit -i override the link', async () => {
        // The deliberate per-invocation escape hatch: point at an API directly
        // when discovery cannot get there on its own.
        const info = await collectInfo(session(), `${otherOrigin}/download/plain`);
        expect(info.instance).toBe('Stub');
    });

    it('falls back to the configured instance for a bare id', async () => {
        // A bare id carries no origin, so the configured one is all there is.
        const info = await collectInfo(session(), 'plain');
        expect(info.instance).toBe('Stub');
    });
});
