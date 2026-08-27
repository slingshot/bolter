/**
 * `sendfm report` — turn a local trace into something shareable.
 *
 * This is the only path by which anything about a run leaves the machine, and
 * it runs because a person typed it. `--send` is a further, separate opt-in:
 * printing a bundle to paste is the default, because reading what you are
 * about to share is a reasonable thing to want.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { defineCommand, option } from '../cli';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand } from '../core/session';
import { listTraces, redact } from '../trace/writer';
import type { Output } from '../ui/output';

const REPO = 'slingshot/bolter';

export interface ReportData {
    runId: string;
    version: string;
    platform: string;
    events: number;
    /** The redacted bundle, ready to paste. */
    bundle: string;
    issueUrl: string;
}

/** Build the bundle. Everything here has already been redacted once at write time. */
export function buildBundle(runId: string, lines: string[]): string {
    const events = lines.filter(Boolean).map((line) => {
        try {
            return redact(JSON.parse(line));
        } catch {
            // A truncated final line (a killed process) is worth keeping as a
            // fact about the run rather than dropping silently.
            return { event: 'trace.unparseable', raw: '[truncated]' };
        }
    });
    return JSON.stringify(
        {
            sendfm: pkg.version,
            platform: `${process.platform}-${process.arch}`,
            runId,
            events,
        },
        null,
        2,
    );
}

function render(data: ReportData, output: Output): void {
    const { theme } = output;
    output.note(theme.muted(`Run ${data.runId} · ${data.events} events`));
    output.note(
        theme.muted('Everything below has been redacted: no keys, tokens, signed URLs or paths.'),
    );
    output.note('');
    output.note(theme.muted(`Open an issue with it: ${data.issueUrl}`));
    output.result(data.bundle);
}

export default defineCommand({
    name: 'report',
    description: 'Produce a redacted diagnostic bundle from a local trace',
    options: {
        ...globalOptions,
        run: option(z.string().optional(), {
            description: 'Which run to report (default: the most recent)',
        }),
    },
    handler: async ({ flags }) => {
        const code = await runCommand(
            { name: 'report', flags: globalFlagsFrom(flags) },
            (session): CommandResult<ReportData> => {
                const traces = listTraces(session.env);
                const selected = flags.run
                    ? traces.find((path) => path.includes(flags.run as string))
                    : traces[0];
                if (!selected) {
                    throw new SendfmError('LOCAL_STATE', 'No trace to report.', {
                        hint: 'Traces are written as you use sendfm; run a command first.',
                    });
                }
                const runId =
                    selected
                        .split('/')
                        .pop()
                        ?.replace(/\.ndjson$/, '') ?? selected;
                const lines = readFileSync(selected, 'utf8').split('\n');
                const bundle = buildBundle(runId, lines);
                const data: ReportData = {
                    runId,
                    version: pkg.version,
                    platform: `${process.platform}-${process.arch}`,
                    events: lines.filter(Boolean).length,
                    bundle,
                    issueUrl: `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(
                        `sendfm ${pkg.version}: `,
                    )}`,
                };
                return { data, render: (output) => render(data, output) };
            },
        );
        process.exitCode = code;
    },
});
