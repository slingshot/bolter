import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coerceValue, getPath, setPath } from '../src/commands/config';
import { DEFAULT_INSTANCE, loadConfig, resolveInstanceOrigin } from '../src/core/config';
import { SendfmError } from '../src/core/errors';

let root: string;
let configHome: string;
let project: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sendfm-cfg-'));
    configHome = join(root, 'config');
    project = join(root, 'project');
    mkdirSync(configHome, { recursive: true });
    mkdirSync(project, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const env = () => ({ SENDFM_CONFIG_DIR: configHome }) as NodeJS.ProcessEnv;

function writeUser(values: unknown) {
    writeFileSync(join(configHome, 'config.json'), JSON.stringify(values));
}

function writeProject(values: unknown) {
    writeFileSync(join(project, '.sendfmrc.json'), JSON.stringify(values));
}

describe('precedence', () => {
    it('lets a project file override the user file', () => {
        writeUser({ instance: 'https://user.example', defaults: { downloads: 1 } });
        writeProject({ instance: 'https://project.example' });
        const { values } = loadConfig({ env: env(), cwd: project });
        expect(values.instance).toBe('https://project.example');
        // Sections merge rather than replace, so an unrelated user default
        // survives a project file that says nothing about it.
        expect(values.defaults?.downloads).toBe(1);
    });

    it('reports which files contributed', () => {
        writeUser({ instance: 'https://user.example' });
        writeProject({ defaults: { downloads: 3 } });
        const { sources } = loadConfig({ env: env(), cwd: project });
        expect(sources).toHaveLength(2);
        expect(sources[1]).toContain('.sendfmrc.json');
    });

    it('treats no config at all as empty, not an error', () => {
        expect(loadConfig({ env: env(), cwd: project })).toEqual({ values: {}, sources: [] });
    });
});

describe('malformed config', () => {
    it('refuses to start rather than silently ignoring a broken file', () => {
        writeFileSync(join(configHome, 'config.json'), '{ not json');
        expect(() => loadConfig({ env: env(), cwd: project })).toThrow(SendfmError);
    });

    it('names the offending key when a value has the wrong type', () => {
        writeUser({ defaults: { downloads: 'many' } });
        expect(() => loadConfig({ env: env(), cwd: project })).toThrow(/defaults.downloads/);
    });

    it('rejects unknown keys, so a typo does not silently do nothing', () => {
        writeUser({ instnace: 'https://typo.example' });
        expect(() => loadConfig({ env: env(), cwd: project })).toThrow(SendfmError);
    });

    it('fails on a missing --config path instead of falling back', () => {
        // Asked for explicitly, so a fallback would hide the typo.
        expect(() =>
            loadConfig({ env: env(), cwd: project, explicitPath: join(root, 'nope.json') }),
        ).toThrow(/No config file at/);
    });
});

describe('instance resolution', () => {
    it('defaults to send.fm', () => {
        expect(resolveInstanceOrigin({ config: {}, env: {} })).toBe(DEFAULT_INSTANCE);
    });

    it('prefers the flag over the environment over the config', () => {
        const config = { instance: 'https://config.example' };
        expect(resolveInstanceOrigin({ flag: 'https://flag.example', config, env: {} })).toBe(
            'https://flag.example',
        );
        expect(
            resolveInstanceOrigin({ config, env: { SENDFM_INSTANCE: 'https://env.example' } }),
        ).toBe('https://env.example');
        expect(resolveInstanceOrigin({ config, env: {} })).toBe('https://config.example');
    });

    it('resolves a named alias', () => {
        expect(
            resolveInstanceOrigin({
                flag: 'work',
                config: { instances: { work: { url: 'https://files.work.example' } } },
                env: {},
            }),
        ).toBe('https://files.work.example');
    });

    it('upgrades a bare hostname to https rather than http', () => {
        // Silently downgrading someone's transfer to plaintext is not a
        // convenience worth having.
        expect(resolveInstanceOrigin({ flag: 'files.example:8080', config: {}, env: {} })).toBe(
            'https://files.example:8080',
        );
    });

    it('reduces a pasted share link to its origin', () => {
        // People know the frontend URL because they are holding a link, so
        // pasting the whole thing into -i is the obvious move. Left as-is it
        // would probe /download/<id>/instance.json, which a single-page app
        // answers with its own HTML and a 200.
        expect(
            resolveInstanceOrigin({ flag: 'https://send.fm/download/abc123', config: {}, env: {} }),
        ).toBe('https://send.fm');
        expect(
            resolveInstanceOrigin({
                flag: 'https://send.fm/download/abc123#kQ7secret',
                config: {},
                env: {},
            }),
        ).toBe('https://send.fm');
    });

    it('keeps a subpath, which is a real deployment shape', () => {
        // Discovery probes `${base}/instance.json`, so an instance mounted at
        // /bolter works today. Stripping every path to satisfy the share-link
        // case would break it.
        expect(
            resolveInstanceOrigin({ flag: 'https://example.com/bolter', config: {}, env: {} }),
        ).toBe('https://example.com/bolter');
    });

    it('drops a bare trailing slash', () => {
        expect(resolveInstanceOrigin({ flag: 'https://send.fm/', config: {}, env: {} })).toBe(
            'https://send.fm',
        );
    });

    it('rejects something that is neither an alias nor a host', () => {
        expect(() => resolveInstanceOrigin({ flag: 'not a host', config: {}, env: {} })).toThrow(
            /Unknown instance/,
        );
    });
});

describe('config key paths', () => {
    it('reads and writes dotted paths', () => {
        const next = setPath({}, 'instances.work.url', 'https://work.example');
        expect(getPath(next, 'instances.work.url')).toBe('https://work.example');
    });

    it('unsets by writing undefined', () => {
        const next = setPath({ instance: 'https://a.example' }, 'instance', undefined);
        expect(getPath(next, 'instance')).toBeUndefined();
    });

    it('does not mutate the source', () => {
        const before = { instance: 'https://a.example' };
        setPath(before, 'instance', 'https://b.example');
        expect(before.instance).toBe('https://a.example');
    });

    it('coerces shell strings to the types the schema expects', () => {
        expect(coerceValue('true')).toBe(true);
        expect(coerceValue('false')).toBe(false);
        expect(coerceValue('4')).toBe(4);
        expect(coerceValue('https://send.fm')).toBe('https://send.fm');
        expect(coerceValue('{"a":1}')).toEqual({ a: 1 });
        // A filename can legitimately start with `[`, so a failed JSON parse
        // has to fall back to text rather than erroring.
        expect(coerceValue('[draft] notes.txt')).toBe('[draft] notes.txt');
    });
});
