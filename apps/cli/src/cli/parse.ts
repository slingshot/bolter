/**
 * argv in, validated flags out.
 *
 * The parsing itself is `node:util`'s `parseArgs`, which Bun implements — a
 * dependency-free parser is worth more here than a featureful one, because
 * every option is already a Zod schema and Zod is what should be deciding
 * whether `--limit abc` is acceptable.
 */

import { parseArgs } from 'node:util';
import { SendfmError } from '../core/errors';
import { isFlag, type Options } from './define';

export interface ParsedInvocation {
    flags: Record<string, unknown>;
    positional: string[];
}

/**
 * `parseArgs` has no notion of `--no-x`, and it is strict, so an undeclared
 * `--no-color` is an error rather than a negation. Declaring a companion
 * boolean for every flag is what makes the negated form parse; `applyNegation`
 * then folds it back onto the real name.
 *
 * Deliberately not a general "any `--no-` prefix means false" rule: that would
 * silently accept `--no-instance` and every other nonsense, and the point of
 * strict parsing is to catch a typo before it becomes a shrug.
 */
function parseArgsConfig(options: Options) {
    const config: Record<
        string,
        { type: 'boolean' | 'string'; short?: string; multiple?: boolean }
    > = {};
    for (const [name, def] of Object.entries(options)) {
        config[name] = {
            type: isFlag(def) ? 'boolean' : 'string',
            ...(def.short ? { short: def.short } : {}),
        };
        if (isFlag(def)) {
            config[`no-${name}`] = { type: 'boolean' };
        }
    }
    return config;
}

/**
 * Turn `parseArgs`'s own failures into the CLI's error type.
 *
 * Left alone they surface as a stack trace with an internal Node error code,
 * which tells someone who mistyped a flag nothing they can act on.
 */
function friendlyParseError(error: unknown, commandName: string): never {
    const code = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
        const flag = message.match(/'([^']+)'/)?.[1] ?? 'that option';
        throw new SendfmError('USAGE', `Unknown option ${flag}.`, {
            hint: `sendfm ${commandName} --help lists what this command takes.`,
        });
    }
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
        throw new SendfmError('USAGE', message, {
            hint: `sendfm ${commandName} --help lists what this command takes.`,
        });
    }
    throw new SendfmError('USAGE', message);
}

export function parseInvocation(
    options: Options,
    argv: string[],
    commandName: string,
): ParsedInvocation {
    let values: Record<string, unknown>;
    let positionals: string[];
    try {
        ({ values, positionals } = parseArgs({
            args: argv,
            options: parseArgsConfig(options),
            allowPositionals: true,
            strict: true,
        }) as { values: Record<string, unknown>; positionals: string[] });
    } catch (error) {
        friendlyParseError(error, commandName);
    }

    const flags: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(options)) {
        // `--no-x` wins over `--x`: someone who wrote both meant the last
        // thing they thought about, and refusing the combination outright
        // would break `sendfm ls --color --no-color` in a shell alias.
        const raw = values[`no-${name}`] === true ? false : values[name];
        const result = def.schema.safeParse(raw);
        if (!result.success) {
            const issue = result.error.issues[0];
            throw new SendfmError('USAGE', `--${name}: ${issue?.message ?? 'invalid value'}`, {
                hint: `sendfm ${commandName} --help describes this option.`,
            });
        }
        flags[name] = result.data;
    }

    return { flags, positional: positionals };
}
