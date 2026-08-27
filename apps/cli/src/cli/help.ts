/**
 * Help text.
 *
 * Where it goes is a decision, not an accident. Help someone *asked* for is
 * the result of the command they ran, so it goes to stdout and exits 0 —
 * `sendfm --help | less` has to work. Help shown *because something was wrong*
 * is commentary on a failure, so it goes to stderr with a usage exit code.
 *
 * Bunli got this wrong in a way worth remembering: it emitted a JSON envelope
 * for `--help` whenever stdout was not a terminal, so piping help produced
 * `{"ok":true,"data":{"type":"help",…}}` — a different envelope from the one
 * this CLI documents, for a request that was never about JSON.
 */

import { type CommandDef, isFlag, type Options } from './define';

/** Terminal width to wrap at, clamped so help is neither cramped nor sprawling. */
export function helpWidth(columns: number | undefined): number {
    return Math.max(60, Math.min(columns ?? 80, 100));
}

function wrap(text: string, width: number): string[] {
    if (!text) {
        return [''];
    }
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
        if (line && `${line} ${word}`.length > width) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) {
        lines.push(line);
    }
    return lines;
}

/** A two-column block whose second column wraps under itself. */
function describeRows(rows: Array<[string, string]>, width: number, indent = 2): string[] {
    if (rows.length === 0) {
        return [];
    }
    const gutter = Math.max(...rows.map(([label]) => label.length));
    const pad = indent + gutter + 2;
    const out: string[] = [];
    for (const [label, description] of rows) {
        const [first, ...rest] = wrap(description, Math.max(20, width - pad));
        out.push(`${' '.repeat(indent)}${label.padEnd(gutter)}  ${first}`.trimEnd());
        for (const line of rest) {
            out.push(`${' '.repeat(pad)}${line}`);
        }
    }
    return out;
}

function optionLabel(name: string, def: Options[string]): string {
    // Options without a short form still reserve its width, so the long names
    // line up whether or not their neighbours have letters.
    const short = def.short ? `-${def.short}, ` : '    ';
    return `${short}--${name}${isFlag(def) ? '' : ' <value>'}`;
}

export function renderCommandHelp(cliName: string, command: CommandDef, width: number): string {
    const usage = [`${cliName} ${command.name}`, '[options]'];
    const out = [`Usage: ${usage.join(' ')}`];
    if (command.description) {
        out.push('', ...wrap(command.description, width));
    }

    const options = Object.entries(command.options ?? {});
    if (options.length > 0) {
        out.push('', 'Options:');
        out.push(
            ...describeRows(
                options.map(([name, def]) => [optionLabel(name, def), def.description ?? '']),
                width,
            ),
        );
    }

    if (command.alias?.length) {
        out.push('', `Also: ${command.alias.map((a) => `${cliName} ${a}`).join(', ')}`);
    }
    return out.join('\n');
}

export function renderRootHelp(
    cli: { name: string; version: string; description?: string },
    commands: CommandDef[],
    width: number,
): string {
    const out = [`${cli.name} v${cli.version}`];
    if (cli.description) {
        out.push(...wrap(cli.description, width));
    }
    out.push('', `Usage: ${cli.name} <command> [options]`, '', 'Commands:');
    out.push(
        ...describeRows(
            [...commands]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => [c.name, c.description ?? '']),
            width,
        ),
    );
    out.push('', `Run \`${cli.name} <command> --help\` for a command's options.`);
    return out.join('\n');
}
