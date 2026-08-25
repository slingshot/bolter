/**
 * Where words go.
 *
 * One rule decides the whole design: **stdout carries the result, stderr
 * carries everything about producing it.** So `sendfm up notes.pdf | pbcopy`
 * copies a share link and nothing else, `--json` can guarantee stdout is a
 * single parseable object, and progress never corrupts a pipe.
 */

import { resolveTheme, symbols, type Theme } from './theme';

export type OutputMode = 'json' | 'plain' | 'rich';

export interface OutputOptions {
    json: boolean;
    quiet: boolean;
    noColor: boolean;
    stdoutIsTTY: boolean;
    stderrIsTTY: boolean;
    env: Record<string, string | undefined>;
    /** Injectable so tests can assert on stream discipline. */
    write?: (stream: 'out' | 'err', text: string) => void;
}

export interface Output {
    readonly mode: OutputMode;
    readonly theme: Theme;
    readonly isInteractive: boolean;
    /** The answer. stdout. */
    result(text: string): void;
    /** Human commentary. stderr, suppressed by --quiet. */
    note(text: string): void;
    /** Blank separator on stderr, suppressed by --quiet. */
    blank(): void;
    warn(text: string): void;
    error(text: string): void;
    /** A whole JSON envelope. stdout, exactly once. */
    emitJson(value: unknown): void;
}

export function createOutput(options: OutputOptions): Output {
    const write =
        options.write ??
        ((stream: 'out' | 'err', text: string) => {
            (stream === 'out' ? process.stdout : process.stderr).write(text);
        });

    const mode: OutputMode = options.json
        ? 'json'
        : // Rich output is for a person watching. Anything else — a pipe, a log
          // file, CI — gets plain text with no escapes and no redraws.
          options.stderrIsTTY && !options.noColor
          ? 'rich'
          : 'plain';

    const theme = resolveTheme({
        isTTY: options.stderrIsTTY,
        noColor: options.noColor || options.json,
        env: options.env,
    });

    const quiet = options.quiet || options.json;

    return {
        mode,
        theme,
        isInteractive: options.stderrIsTTY && !options.json,

        result(text) {
            write('out', `${text}\n`);
        },

        note(text) {
            if (!quiet) {
                write('err', `${text}\n`);
            }
        },

        blank() {
            if (!quiet) {
                write('err', '\n');
            }
        },

        warn(text) {
            // Warnings survive --quiet: suppressing them is how someone ends up
            // acting on a result that came with a caveat.
            write('err', `${theme.warning(`${symbols.warn} ${text}`)}\n`);
        },

        error(text) {
            write('err', `${theme.danger(`${symbols.fail} ${text}`)}\n`);
        },

        emitJson(value) {
            write('out', `${JSON.stringify(value, null, 2)}\n`);
        },
    };
}
