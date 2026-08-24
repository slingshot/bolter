import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from '../src/commands/report';
import {
    assetNameFor,
    detectInstallMethod,
    type InstallMethod,
    isNewer,
} from '../src/commands/update';
import { createTracer, listTraces, redact } from '../src/trace/writer';

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sendfm-trace-'));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

const env = () => ({ SENDFM_STATE_DIR: home }) as NodeJS.ProcessEnv;

/**
 * Redaction is the load-bearing part: a trace exists to be pasted into an
 * issue, so anything secret that survives it is published by design.
 */
describe('redaction', () => {
    it('strips the query string from a URL, which is where a signature lives', () => {
        expect(
            redact('https://bucket.r2.example/obj?X-Amz-Signature=deadbeef&X-Amz-Expires=900'),
        ).toBe('https://bucket.r2.example/obj?[redacted]');
    });

    it('keeps a URL with no query intact, so origins stay diagnosable', () => {
        expect(redact('https://api.send.fm/upload/url')).toBe('https://api.send.fm/upload/url');
    });

    it.each([
        'secret',
        'ownerToken',
        'authKey',
        'password',
        'Cookie',
        'uploadToken',
    ])('drops the value of %s', (key) => {
        expect(redact('sensitive-value', key)).toBe('[redacted]');
    });

    it('reduces an absolute path to its basename', () => {
        // A home directory carries a real person's name.
        expect(redact('/Users/someone/Documents/tax-return.pdf')).toBe('…/tax-return.pdf');
        expect(redact('C:\\Users\\someone\\secret.txt')).toBe('…/secret.txt');
    });

    it('recurses into objects and arrays', () => {
        expect(
            redact({
                id: 'abc',
                parts: [{ url: 'https://s3.example/p?sig=1', etag: '"x"' }],
                nested: { secret: 'no' },
            }),
        ).toEqual({
            id: 'abc',
            parts: [{ url: 'https://s3.example/p?[redacted]', etag: '"x"' }],
            nested: { secret: '[redacted]' },
        });
    });

    it('keeps an error’s shape, which is the point of reporting one', () => {
        const result = redact(new Error('boom')) as { name: string; message: string };
        expect(result.name).toBe('Error');
        expect(result.message).toBe('boom');
    });
});

describe('tracer', () => {
    it('writes NDJSON with a run.start marker', () => {
        const tracer = createTracer('up', env());
        tracer.event('upload.part', { partNumber: 3 });
        tracer.close();

        const lines = readFileSync(tracer.path, 'utf8').split('\n').filter(Boolean);
        const events = lines.map((line) => JSON.parse(line) as { event: string });
        expect(events[0].event).toBe('run.start');
        expect(events.map((e) => e.event)).toContain('upload.part');
        expect(events[events.length - 1].event).toBe('run.end');
    });

    it('redacts as it writes, not when sharing', () => {
        // Relying on a later pass to remember is how secrets escape.
        const tracer = createTracer('up', env());
        tracer.event('upload.part', { url: 'https://s3.example/p?sig=abc', secret: 'k3y' });
        tracer.close();
        const contents = readFileSync(tracer.path, 'utf8');
        expect(contents).not.toContain('sig=abc');
        expect(contents).not.toContain('k3y');
    });

    it('degrades to a no-op rather than failing the command', () => {
        // A read-only home or a sandbox must not take an upload down with it.
        const tracer = createTracer('up', {
            SENDFM_STATE_DIR: '/proc/definitely-not-writable',
        } as NodeJS.ProcessEnv);
        expect(() => {
            tracer.event('x');
            tracer.close();
        }).not.toThrow();
    });

    it('keeps only the most recent traces', () => {
        for (let i = 0; i < 25; i++) {
            createTracer(`run${i}`, env(), Date.now() + i * 1000).close();
        }
        expect(readdirSync(join(home, 'traces')).length).toBeLessThanOrEqual(21);
    });

    it('lists traces newest first', () => {
        createTracer('older', env(), Date.now() - 10_000).close();
        createTracer('newer', env(), Date.now()).close();
        const traces = listTraces(env());
        expect(traces[0]).toContain('newer');
    });
});

describe('report bundle', () => {
    it('survives a truncated final line, which is what a killed process leaves', () => {
        const bundle = JSON.parse(
            buildBundle('run-1', ['{"event":"run.start"}', '{"event":"broke']),
        ) as { events: Array<{ event: string }> };
        expect(bundle.events).toHaveLength(2);
        expect(bundle.events[1].event).toBe('trace.unparseable');
    });

    it('redacts again on the way out', () => {
        const bundle = buildBundle('run-1', [
            JSON.stringify({ event: 'x', url: 'https://s3.example/p?sig=abc' }),
        ]);
        expect(bundle).not.toContain('sig=abc');
    });
});

describe('install method detection', () => {
    it.each([
        ['/opt/homebrew/Cellar/sendfm/0.1.0/bin/sendfm', 'homebrew'],
        ['/home/linuxbrew/.linuxbrew/bin/sendfm', 'homebrew'],
        ['/usr/lib/node_modules/sendfm/bin/sendfm', 'npm'],
        ['/usr/local/bin/sendfm', 'standalone'],
    ] as Array<[string, InstallMethod]>)('reads %s as %s', (path, expected) => {
        expect(detectInstallMethod(path, {} as NodeJS.ProcessEnv)).toBe(expected);
    });

    it('recognises running from source, where there is nothing to replace', () => {
        expect(detectInstallMethod('/Users/x/.bun/bin/bun', {} as NodeJS.ProcessEnv)).toBe(
            'source',
        );
    });

    it('can be overridden, for packagers whose layout does not match', () => {
        expect(
            detectInstallMethod('/usr/local/bin/sendfm', {
                SENDFM_INSTALL_METHOD: 'docker',
            } as NodeJS.ProcessEnv),
        ).toBe('docker');
    });
});

describe('version comparison', () => {
    it.each([
        ['1.0.1', '1.0.0', true],
        ['1.1.0', '1.0.9', true],
        ['2.0.0', '1.9.9', true],
        ['1.0.0', '1.0.0', false],
        ['0.9.0', '1.0.0', false],
        ['v1.0.1', '1.0.0', true],
    ])('%s newer than %s is %s', (candidate, current, expected) => {
        expect(isNewer(candidate, current)).toBe(expected);
    });

    it('does not compare numerically as strings', () => {
        // '10' < '9' lexically, which would stall every user on 0.9.x.
        expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    });
});

describe('release asset naming', () => {
    it('matches what bunli-releaser publishes', () => {
        expect(assetNameFor('1.2.3', 'darwin', 'arm64')).toBe('sendfm-1.2.3-darwin-arm64.tar.gz');
        expect(assetNameFor('1.2.3', 'linux', 'x64')).toBe('sendfm-1.2.3-linux-x64.tar.gz');
        // Windows archives are zips, and the platform is named `windows`.
        expect(assetNameFor('1.2.3', 'win32', 'x64')).toBe('sendfm-1.2.3-windows-x64.zip');
    });
});
