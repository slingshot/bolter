import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineCommand, option } from '../src/cli';
import { renderCompletions } from '../src/cli/completions';
import { renderCommandHelp, renderRootHelp } from '../src/cli/help';
import { parseInvocation } from '../src/cli/parse';
import { SendfmError } from '../src/core/errors';

const options = {
    json: option(z.coerce.boolean().default(false), {
        description: 'Emit a single JSON object on stdout',
        argumentKind: 'flag',
    }),
    color: option(z.coerce.boolean().default(true), {
        description: 'Colour output',
        argumentKind: 'flag',
    }),
    instance: option(z.string().optional(), { short: 'i', description: 'Instance URL' }),
    limit: option(z.coerce.number().int().positive().max(1000).default(50), {
        description: 'How many to show',
    }),
};

const parse = (argv: string[]) => parseInvocation(options, argv, 'demo');

describe('flag parsing', () => {
    it('applies schema defaults when a flag is absent', () => {
        expect(parse([]).flags).toEqual({
            json: false,
            color: true,
            instance: undefined,
            limit: 50,
        });
    });

    it('reads long flags, short flags and values', () => {
        const { flags } = parse(['--json', '-i', 'https://send.fm', '--limit', '3']);
        expect(flags.json).toBe(true);
        expect(flags.instance).toBe('https://send.fm');
        expect(flags.limit).toBe(3);
    });

    it('collects everything else as positionals, in order', () => {
        const { positional } = parse(['a.txt', '--json', 'b.txt']);
        expect(positional).toEqual(['a.txt', 'b.txt']);
    });

    /**
     * `parseArgs` has no negation of its own and is strict, so `--no-color`
     * would be an unknown option rather than a negation unless the companion
     * boolean is declared for it.
     */
    describe('negation', () => {
        it('turns a flag off', () => {
            expect(parse(['--no-color']).flags.color).toBe(false);
        });

        it('lets the negated form win, so a shell alias can override', () => {
            expect(parse(['--color', '--no-color']).flags.color).toBe(false);
        });

        it('is accepted for every flag, not just the ones that default on', () => {
            expect(parse(['--no-json']).flags.json).toBe(false);
        });

        it('is not a general prefix — only declared flags negate', () => {
            // Otherwise `--no-instance` and every other typo parse silently,
            // which is exactly what strict parsing is for.
            expect(() => parse(['--no-instance'])).toThrow(SendfmError);
        });
    });
});

describe('errors are usage errors, not stack traces', () => {
    it('names the unknown option', () => {
        try {
            parse(['--nope']);
            throw new Error('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(SendfmError);
            expect((error as SendfmError).code).toBe('USAGE');
            expect((error as SendfmError).message).toContain('--nope');
        }
    });

    it("reports the schema's own complaint about a bad value", () => {
        try {
            parse(['--limit', 'abc']);
            throw new Error('should have thrown');
        } catch (error) {
            expect((error as SendfmError).code).toBe('USAGE');
            expect((error as SendfmError).message).toContain('--limit');
        }
    });

    it("enforces the schema's bounds, not just its type", () => {
        expect(() => parse(['--limit', '99999'])).toThrow(SendfmError);
        expect(() => parse(['--limit', '0'])).toThrow(SendfmError);
    });
});

const demo = defineCommand({
    name: 'demo',
    alias: ['d'],
    description: 'A demonstration command',
    options,
    handler: () => undefined,
});

describe('help', () => {
    it('lists every option with its short form', () => {
        const text = renderCommandHelp('sendfm', demo, 80);
        expect(text).toContain('--json');
        expect(text).toContain('-i, --instance <value>');
        // A flag takes no value; saying it does would be a lie.
        expect(text).not.toContain('--json <value>');
    });

    it('mentions aliases so `sendfm d` is discoverable', () => {
        expect(renderCommandHelp('sendfm', demo, 80)).toContain('sendfm d');
    });

    it('wraps to the given width', () => {
        const long = defineCommand({
            name: 'x',
            description: 'w '.repeat(80).trim(),
            handler: () => undefined,
        });
        const lines = renderRootHelp({ name: 's', version: '1' }, [long], 60).split('\n');
        expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(60);
    });

    it('sorts commands so the list is scannable', () => {
        const text = renderRootHelp(
            { name: 'sendfm', version: '1' },
            [
                defineCommand({ name: 'up', handler: () => undefined }),
                defineCommand({ name: 'get', handler: () => undefined }),
            ],
            80,
        );
        expect(text.indexOf('get')).toBeLessThan(text.indexOf('up'));
    });
});

describe('completions', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
        it(`generates a ${shell} script naming every command and alias`, () => {
            const script = renderCompletions(shell, 'sendfm', [demo]);
            expect(script).toContain('demo');
            expect(script).toContain('sendfm');
            expect(script.length).toBeGreaterThan(100);
        });
    }

    it('offers --no- only for flags that are already on', () => {
        // `--no-json` alongside `--json` doubles the list and says nothing.
        const script = renderCompletions('bash', 'sendfm', [demo]);
        expect(script).toContain('--no-color');
        expect(script).not.toContain('--no-json');
    });

    it('escapes quotes so a description cannot break out of the script', () => {
        const quoted = defineCommand({
            name: 'q',
            description: "it's got a quote",
            handler: () => undefined,
        });
        const script = renderCompletions('fish', 'sendfm', [quoted]);
        expect(script).toContain(`'it'\\''s got a quote'`);
    });

    it('escapes colons in zsh descriptions, which _describe splits on', () => {
        const colon = defineCommand({
            name: 'c',
            description: 'before: after',
            handler: () => undefined,
        });
        expect(renderCompletions('zsh', 'sendfm', [colon])).toContain('before\\: after');
    });
});
