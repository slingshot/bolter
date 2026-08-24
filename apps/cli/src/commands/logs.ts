/**
 * `sendfm logs` — find and read the local traces.
 *
 * Nothing is ever sent anywhere, so this is the only way a trace becomes
 * useful: you look at it, or you hand it to someone with `sendfm report`.
 */

import { readFileSync } from 'node:fs';
import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { traceDir } from '../core/paths';
import { type CommandResult, runCommand } from '../core/session';
import { listTraces } from '../trace/writer';
import type { Output } from '../ui/output';

export interface LogsData {
    directory: string;
    runs: string[];
    /** Events of the selected run, when one was shown. */
    events?: unknown[];
}

function render(data: LogsData, output: Output): void {
    const { theme } = output;
    if (data.events) {
        for (const event of data.events) {
            output.result(JSON.stringify(event));
        }
        return;
    }
    if (data.runs.length === 0) {
        output.note(theme.muted('No traces recorded yet.'));
        output.result(data.directory);
        return;
    }
    for (const run of data.runs) {
        output.note(`  ${theme.muted(run)}`);
    }
    output.result(data.directory);
}

export default defineCommand({
    name: 'logs',
    description: 'Show where local traces live, or print one',
    options: {
        ...globalOptions,
        last: option(z.coerce.boolean().default(false), {
            description: 'Print the most recent run instead of listing them',
            argumentKind: 'flag',
        }),
        run: option(z.string().optional(), {
            description: 'Print a specific run by id',
        }),
    },
    handler: async ({ flags }) => {
        const code = await runCommand(
            { name: 'logs', flags: globalFlagsFrom(flags) },
            (session): CommandResult<LogsData> => {
                const directory = traceDir(session.env);
                const traces = listTraces(session.env);
                const runs = traces.map(
                    (path) =>
                        path
                            .split('/')
                            .pop()
                            ?.replace(/\.ndjson$/, '') ?? path,
                );

                if (!flags.last && !flags.run) {
                    const data: LogsData = { directory, runs };
                    return { data, render: (output) => render(data, output) };
                }

                const selected = flags.run
                    ? traces.find((path) => path.includes(flags.run as string))
                    : traces[0];
                if (!selected) {
                    throw new SendfmError('LOCAL_STATE', 'No matching trace.', {
                        hint: 'Run `sendfm logs` to see what is recorded.',
                    });
                }
                const events = readFileSync(selected, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as unknown);
                const data: LogsData = { directory, runs, events };
                return { data, render: (output) => render(data, output) };
            },
        );
        process.exitCode = code;
    },
});
