import { describe, expect, it } from 'bun:test';
import { createOutput, type OutputOptions } from '../src/ui/output';

function capture(overrides: Partial<OutputOptions> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const output = createOutput({
        json: false,
        quiet: false,
        noColor: true,
        stdoutIsTTY: false,
        stderrIsTTY: false,
        env: {},
        write: (stream, text) => (stream === 'out' ? out : err).push(text),
        ...overrides,
    });
    return { output, out, err };
}

/**
 * The stream split is the contract everything else leans on: `sendfm up f |
 * pbcopy` has to copy a link and nothing else, and `--json` has to be able to
 * promise stdout is one parseable object.
 */
describe('stream discipline', () => {
    it('puts the result on stdout and commentary on stderr', () => {
        const { output, out, err } = capture();
        output.note('uploading…');
        output.result('https://send.fm/download/abc#key');
        expect(out).toEqual(['https://send.fm/download/abc#key\n']);
        expect(err).toEqual(['uploading…\n']);
    });

    it('keeps warnings and errors off stdout', () => {
        const { output, out, err } = capture();
        output.warn('retried a part');
        output.error('gave up');
        expect(out).toEqual([]);
        expect(err.join('')).toContain('retried a part');
        expect(err.join('')).toContain('gave up');
    });

    it('emits JSON only on stdout', () => {
        const { output, out, err } = capture({ json: true });
        output.emitJson({ ok: true });
        expect(err).toEqual([]);
        expect(JSON.parse(out.join(''))).toEqual({ ok: true });
    });
});

describe('quiet', () => {
    it('drops notes but keeps warnings', () => {
        // A suppressed warning is how someone acts on a result that came with
        // a caveat they never saw.
        const { output, err } = capture({ quiet: true });
        output.note('uploading…');
        output.warn('part 3 retried');
        expect(err.join('')).not.toContain('uploading');
        expect(err.join('')).toContain('part 3 retried');
    });

    it('is implied by --json, so commentary cannot corrupt a pipe', () => {
        const { output, out, err } = capture({ json: true });
        output.note('uploading…');
        expect(out).toEqual([]);
        expect(err).toEqual([]);
    });
});

describe('mode selection', () => {
    it('is plain when stderr is not a terminal', () => {
        expect(capture({ stderrIsTTY: false }).output.mode).toBe('plain');
    });

    it('is rich only for a terminal with colour allowed', () => {
        expect(capture({ stderrIsTTY: true, noColor: false }).output.mode).toBe('rich');
        expect(capture({ stderrIsTTY: true, noColor: true }).output.mode).toBe('plain');
    });

    it('is json regardless of terminal', () => {
        expect(capture({ json: true, stderrIsTTY: true, noColor: false }).output.mode).toBe('json');
    });
});

describe('colour', () => {
    it('emits no escapes when NO_COLOR is set, even on a terminal', () => {
        const { output } = capture({ stderrIsTTY: true, noColor: false, env: { NO_COLOR: '1' } });
        expect(output.theme.enabled).toBe(false);
        expect(output.theme.success('ok')).toBe('ok');
    });

    it('emits no escapes for TERM=dumb', () => {
        const { output } = capture({ stderrIsTTY: true, noColor: false, env: { TERM: 'dumb' } });
        expect(output.theme.enabled).toBe(false);
    });

    it('never colours JSON output', () => {
        const { output } = capture({ json: true, stderrIsTTY: true, noColor: false });
        expect(output.theme.enabled).toBe(false);
    });
});
