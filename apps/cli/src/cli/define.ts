/**
 * What a command is.
 *
 * These three functions were `@bunli/core`'s, and keeping their shapes exactly
 * is what let the framework be removed without touching a single handler: a
 * command still declares `{ name, alias, description, options, handler }` and
 * a handler still receives `{ flags, positional }`.
 *
 * An option is a Zod schema plus the things a schema cannot say — what letter
 * it answers to, how to describe it, and whether it takes a value at all.
 * Validation and coercion stay Zod's job, so `--limit abc` is rejected by the
 * same schema that documents the limit.
 */

import type { ZodType } from 'zod';

export interface OptionMeta {
    /** Single letter alias, without the dash. */
    short?: string;
    description?: string;
    /**
     * `'flag'` takes no value and gains a `--no-` form. Anything else consumes
     * the next token.
     */
    argumentKind?: 'flag' | 'value';
}

export interface OptionDef<T = unknown> extends OptionMeta {
    schema: ZodType<T>;
}

export function option<T>(schema: ZodType<T>, meta: OptionMeta = {}): OptionDef<T> {
    return { schema, ...meta };
}

export type Options = Record<string, OptionDef>;

export interface CommandContext {
    /** Every declared option, parsed and validated. */
    flags: Record<string, unknown>;
    /** Everything that was not a flag, in order. */
    positional: string[];
}

export interface CommandDef {
    name: string;
    alias?: string[];
    description?: string;
    options?: Options;
    handler: (context: CommandContext) => unknown | Promise<unknown>;
}

export function defineCommand(def: CommandDef): CommandDef {
    return def;
}

/** True when an option is a bare switch rather than one taking a value. */
export function isFlag(def: OptionDef): boolean {
    return def.argumentKind === 'flag';
}
