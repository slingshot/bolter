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
    /**
     * Whether the result stream is a terminal rather than a pipe or a file.
     *
     * A command that wants to interleave commentary with results — `ls` puts
     * each link directly under the entry it belongs to — cannot do it across
     * two streams: Node only guarantees a terminal write is synchronous on
     * POSIX, and on Windows it is asynchronous, so the two would scramble.
     * Knowing nobody is parsing stdout lets such a command put the whole
     * ordered block on one stream instead.
     */
    readonly stdoutIsTTY: boolean;
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
        stdoutIsTTY: options.stdoutIsTTY,

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
