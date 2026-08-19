/**
 * Flags every command accepts.
 *
 * Bunli scopes options per command, so these are spread into each definition
 * rather than declared once globally. Keeping them in one object is what makes
 * `--json` mean the same thing everywhere — a flag that exists on six of seven
 * commands is worse than one that exists on none.
 */

import { option } from '@bunli/core';
import { z } from 'zod';

export const globalOptions = {
    json: option(z.coerce.boolean().default(false), {
        description: 'Emit a single JSON object on stdout; everything else goes to stderr',
        argumentKind: 'flag',
    }),
    instance: option(z.string().optional(), {
        short: 'i',
        description: 'Instance URL or a configured alias (default: send.fm)',
    }),
    quiet: option(z.coerce.boolean().default(false), {
        short: 'q',
        description: 'Suppress progress and commentary; warnings and errors still print',
        argumentKind: 'flag',
    }),
    verbose: option(z.coerce.boolean().default(false), {
        short: 'v',
        description: 'Include stack traces and per-part detail on failure',
        argumentKind: 'flag',
    }),
    color: option(z.coerce.boolean().default(true), {
        description: 'Colour output (disable with --no-color; NO_COLOR is always honoured)',
        argumentKind: 'flag',
    }),
    config: option(z.string().optional(), {
        description: 'Path to a config file, replacing the usual search',
    }),
} as const;

/** Narrow Bunli's parsed flags to the global subset `runCommand` needs. */
export function globalFlagsFrom(flags: Record<string, unknown>) {
    return {
        json: flags.json as boolean | undefined,
        instance: flags.instance as string | undefined,
        quiet: flags.quiet as boolean | undefined,
        verbose: flags.verbose as boolean | undefined,
        color: flags.color as boolean | undefined,
        config: flags.config as string | undefined,
    };
}
