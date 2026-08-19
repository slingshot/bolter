import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISCOVERY_VERSION, PROTOCOL_VERSION } from '@bolter/protocol';
import { runChecks } from '../src/commands/doctor';
import { EXIT, SendfmError } from '../src/core/errors';
import { createSession, runCommand } from '../src/core/session';

/**
 * A stub instance rather than a mocked client: discovery, compatibility
 * negotiation and the health probe are exactly the wiring worth testing, and
 * mocking them out would leave nothing behind.
 */
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let configHome: string;
let spaMode = false;

beforeAll(() => {
    configHome = mkdtempSync(join(tmpdir(), 'sendfm-session-'));
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const { pathname } = new URL(request.url);
            if (spaMode) {
                // What a single-page app does: 200 and HTML for every path.
                return new Response('<!DOCTYPE html><html></html>', {
                    headers: { 'content-type': 'text/html' },
                });
            }
            if (pathname === '/instance.json') {
                return Response.json({
                    bolter: DISCOVERY_VERSION,
                    name: 'Stub Instance',
                    api: origin,
                    protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION },
                    features: ['multipart'],
                    limits: {
                        maxFileSize: 1_000_000_000,
                        maxFilesPerArchive: 10,
                        maxExpireSeconds: 86400,
                        maxDownloads: 5,
                        multipartThreshold: 100_000_000,
                        minPartSize: 5_242_880,
                        maxParts: 10000,
                        maxMetadataBytes: 524288,
                    },
                    defaults: { expireSeconds: 86400, downloads: 1 },
                });
            }
            if (pathname === '/config') {
                return Response.json({
                    LIMITS: {
                        MAX_FILE_SIZE: 1,
                        MAX_FILES_PER_ARCHIVE: 1,
                        MAX_EXPIRE_SECONDS: 1,
                        MAX_DOWNLOADS: 1,
                    },
                    DEFAULTS: { EXPIRE_SECONDS: 1, DOWNLOADS: 1 },
                    UI: {},
                });
            }
            if (pathname === '/health') {
                return Response.json({
                    status: 'healthy',
                    checks: { redis: 'up', s3: 'up' },
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

function harness(flags: Record<string, unknown> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    return {
        out,
        err,
        options: {
            name: 'test',
            flags: { instance: origin, ...flags },
            env: { SENDFM_CONFIG_DIR: configHome } as NodeJS.ProcessEnv,
            write: (stream: 'out' | 'err', text: string) =>
                (stream === 'out' ? out : err).push(text),
        },
    };
}

describe('runCommand success', () => {
    it('renders for a human and returns OK', async () => {
        const h = harness();
        const code = await runCommand(h.options, () =>
            Promise.resolve({
                data: { answer: 42 },
                render: (output) => output.result('42'),
            }),
        );
        expect(code).toBe(EXIT.OK);
        expect(h.out.join('')).toBe('42\n');
    });

    it('emits a versioned envelope in JSON mode and does not render', async () => {
        const h = harness({ json: true });
        await runCommand(h.options, () =>
            Promise.resolve({
                data: { answer: 42 },
                render: () => {
                    throw new Error('render must not run in JSON mode');
                },
            }),
        );
        expect(JSON.parse(h.out.join(''))).toEqual({
            sendfm: 1,
            ok: true,
            command: 'test',
            data: { answer: 42 },
            warnings: [],
        });
    });

    it('honours an explicit exit code alongside a successful result', async () => {
        // `doctor` reports its findings in full, then exits non-zero.
        const h = harness();
        const code = await runCommand(h.options, () =>
            Promise.resolve({
                data: {},
                render: (output) => output.result('reported'),
                exitCode: EXIT.NETWORK,
            }),
        );
        expect(code).toBe(EXIT.NETWORK);
        expect(h.out.join('')).toBe('reported\n');
    });
});

describe('runCommand failure', () => {
    it('maps the error code to a stable exit code', async () => {
        const h = harness();
        const code = await runCommand(h.options, () =>
            Promise.reject(new SendfmError('GONE', 'expired')),
        );
        expect(code).toBe(EXIT.GONE);
        expect(h.out).toEqual([]);
        expect(h.err.join('')).toContain('expired');
    });

    it('puts the failure in the envelope, not on stderr, in JSON mode', async () => {
        const h = harness({ json: true });
        const code = await runCommand(h.options, () =>
            Promise.reject(new SendfmError('INVALID_KEY', 'bad key', { hint: 're-copy the link' })),
        );
        expect(code).toBe(EXIT.AUTH);
        expect(h.err).toEqual([]);
        expect(JSON.parse(h.out.join(''))).toMatchObject({
            ok: false,
            error: { code: 'INVALID_KEY', message: 'bad key', hint: 're-copy the link' },
        });
    });

    it('classifies an unknown throw as internal rather than crashing', async () => {
        const h = harness();
        const code = await runCommand(h.options, () =>
            Promise.reject(new TypeError('undefined is not a function')),
        );
        expect(code).toBe(EXIT.GENERAL);
    });

    it('reports a config failure even though the session never came up', async () => {
        const h = harness({ config: '/definitely/not/here.json' });
        const code = await runCommand(h.options, () =>
            Promise.resolve({
                data: {},
                render: () => undefined,
            }),
        );
        expect(code).toBe(EXIT.USAGE);
        expect(h.err.join('')).toContain('No config file at');
    });
});

describe('instance resolution', () => {
    it('discovers the stub and reuses it within one invocation', async () => {
        const session = createSession(harness().options);
        const first = await session.instance();
        const second = await session.instance();
        expect(first.name).toBe('Stub Instance');
        expect(second).toBe(first);
    });

    it('explains a single-page app rather than reporting a network failure', async () => {
        spaMode = true;
        try {
            const h = harness();
            const code = await runCommand(h.options, async (session) => {
                await session.instance();
                return { data: {}, render: () => undefined };
            });
            expect(code).toBe(EXIT.NETWORK);
            expect(h.err.join('')).toContain('web page rather than a Bolter API');
        } finally {
            spaMode = false;
        }
    });
});

describe('doctor checks', () => {
    it('passes against a healthy instance and skips the intrusive probe', async () => {
        const session = createSession(harness().options);
        const data = await runChecks(session, false);
        expect(data.healthy).toBe(true);
        expect(data.checks.every((c) => c.status !== 'fail')).toBe(true);
        // The deep probe allocates a real upload, so it must be opt-in.
        expect(data.checks.find((c) => c.name === 'pre-signed PUT')?.status).toBe('skip');
    });

    it('reports the health dependencies it was told about', async () => {
        const session = createSession(harness().options);
        const data = await runChecks(session, false);
        expect(data.checks.find((c) => c.name === 'health')?.detail).toContain('redis up');
    });
});
