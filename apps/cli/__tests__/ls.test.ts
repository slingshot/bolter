import { describe, expect, it } from 'bun:test';
import { describeEntry, type ListEntry, renderList } from '../src/commands/ls';
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

const entry = (overrides: Partial<ListEntry> = {}): ListEntry => ({
    id: '615948f90b254d39',
    name: 'Slingshot-Streaming-Ads-AdSpot.mp4',
    size: 116_000_000,
    instance: 'https://send.fm',
    url: 'https://send.fm/download/615948f90b254d39',
    encrypted: false,
    createdAt: 0,
    expiresAt: null,
    expiresInSeconds: 86_280,
    downloadLimit: 1,
    status: 'complete',
    ...overrides,
});

/**
 * The stream split is the whole reason this command is scriptable, and it is
 * invisible on a terminal — both streams land on the same screen — so nothing
 * but a test will notice it breaking.
 */
describe('stream discipline', () => {
    it('puts bare links, and only links, on a piped stdout', () => {
        const { output, out } = capture({ stdoutIsTTY: false });
        renderList(
            {
                entries: [entry(), entry({ id: 'b', url: 'https://send.fm/download/b' })],
                pruned: 0,
            },
            output,
        );
        expect(out).toEqual([
            'https://send.fm/download/615948f90b254d39\n',
            'https://send.fm/download/b\n',
        ]);
    });

    it('writes nothing at all to stdout when stdout is a terminal', () => {
        // Splitting one entry's block across two streams would leave its
        // ordering to flush timing: Node only guarantees a synchronous
        // terminal write on POSIX, and on Windows it is asynchronous.
        const { output, out, err } = capture({ stdoutIsTTY: true });
        renderList({ entries: [entry()], pruned: 0 }, output);
        expect(out).toEqual([]);
        expect(err.join('')).toContain('https://send.fm/download/615948f90b254d39');
    });

    it('keeps each link adjacent to the entry it belongs to', () => {
        const { output, err } = capture({ stdoutIsTTY: true });
        renderList(
            {
                entries: [
                    entry({ name: 'first.mp4', url: 'https://send.fm/download/one' }),
                    entry({ name: 'second.mp4', url: 'https://send.fm/download/two' }),
                ],
                pruned: 0,
            },
            output,
        );
        const text = err.join('');
        expect(text.indexOf('first.mp4')).toBeLessThan(text.indexOf('one'));
        expect(text.indexOf('one')).toBeLessThan(text.indexOf('second.mp4'));
        expect(text.indexOf('second.mp4')).toBeLessThan(text.indexOf('two'));
    });

    it('emits no link line for an encrypted send whose key was not kept', () => {
        // A link without its fragment resolves to ciphertext nobody can open,
        // so there is nothing to put on stdout and nothing to copy.
        const { output, out, err } = capture({ stdoutIsTTY: false });
        renderList({ entries: [entry({ encrypted: true, url: null })], pruned: 0 }, output);
        expect(out).toEqual([]);
        expect(err.join('')).toContain('key was not stored');
    });
});

describe('describeEntry', () => {
    it('agrees with itself about one download', () => {
        expect(describeEntry(entry({ downloadLimit: 1 }))).toContain('1 download');
        expect(describeEntry(entry({ downloadLimit: 1 }))).not.toContain('1 downloads');
        expect(describeEntry(entry({ downloadLimit: 5 }))).toContain('5 downloads');
    });

    it('distinguishes never-expires from already-expired', () => {
        expect(describeEntry(entry({ expiresInSeconds: null }))).toContain('—');
        expect(describeEntry(entry({ expiresInSeconds: 0 }))).toContain('expired');
        expect(describeEntry(entry({ expiresInSeconds: -5 }))).toContain('expired');
    });

    it('names the states that change what you can do with a link', () => {
        expect(describeEntry(entry({ encrypted: true }))).toContain('encrypted');
        expect(describeEntry(entry({ status: 'pending' }))).toContain('unfinished');
        expect(describeEntry(entry())).not.toContain('unfinished');
    });
});

describe('pruning notice', () => {
    it('counts one entry as an entry', () => {
        const { output, err } = capture();
        renderList({ entries: [entry()], pruned: 1 }, output);
        expect(err.join('')).toContain('1 expired entry forgotten');
    });

    it('counts several as entries', () => {
        const { output, err } = capture();
        renderList({ entries: [entry()], pruned: 3 }, output);
        expect(err.join('')).toContain('3 expired entries forgotten');
    });

    it('says nothing when nothing was pruned', () => {
        const { output, err } = capture();
        renderList({ entries: [entry()], pruned: 0 }, output);
        expect(err.join('')).not.toContain('forgotten');
    });
});

describe('empty state', () => {
    it('says so on stderr and leaves stdout empty', () => {
        const { output, out, err } = capture();
        renderList({ entries: [], pruned: 0 }, output);
        expect(out).toEqual([]);
        expect(err.join('')).toContain('Nothing sent from this machine yet.');
    });
});
