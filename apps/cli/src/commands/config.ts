/**
 * `sendfm config` — read and write the user config file.
 *
 * Writing goes only to the user file, never to a project `.sendfmrc.json`.
 * A project file is checked into someone's repository; a CLI that edits it
 * because you ran `config set` produces a diff nobody asked for.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineCommand } from '@bunli/core';
import { configSchema, type SendfmConfig } from '../core/config';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { configFile } from '../core/paths';
import { type CommandResult, runCommand } from '../core/session';
import { keyValueLines } from '../ui/format';
import type { Output } from '../ui/output';

type ConfigAction = 'list' | 'get' | 'set' | 'unset' | 'path';

export interface ConfigData {
    action: ConfigAction;
    file: string;
    sources: string[];
    values: SendfmConfig;
    key?: string;
    value?: unknown;
}

/** Read a dotted path out of a plain object. */
export function getPath(source: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((value, key) => {
        if (typeof value !== 'object' || value === null) {
            return undefined;
        }
        return (value as Record<string, unknown>)[key];
    }, source);
}

/** Write a dotted path, creating intermediate objects. Returns a new object. */
export function setPath(source: SendfmConfig, path: string, value: unknown): SendfmConfig {
    const keys = path.split('.');
    const root: Record<string, unknown> = structuredClone(source) as Record<string, unknown>;
    let node = root;
    for (const key of keys.slice(0, -1)) {
        const next = node[key];
        node[key] = typeof next === 'object' && next !== null ? next : {};
        node = node[key] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    if (value === undefined) {
        delete node[last];
    } else {
        node[last] = value;
    }
    return root as SendfmConfig;
}

/**
 * Config values come from a shell, so everything arrives as a string.
 * Numbers and booleans are coerced; anything else stays text, and JSON is
 * accepted for the rare nested value.
 */
export function coerceValue(raw: string): unknown {
    if (raw === 'true') {
        return true;
    }
    if (raw === 'false') {
        return false;
    }
    if (raw !== '' && !Number.isNaN(Number(raw))) {
        return Number(raw);
    }
    if (raw.startsWith('{') || raw.startsWith('[')) {
        try {
            return JSON.parse(raw);
        } catch {
            // Not JSON after all — a filename can legitimately start with `[`.
        }
    }
    return raw;
}

function readUserConfig(path: string): SendfmConfig {
    try {
        return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
        // A missing or unreadable user file is the starting point for a write,
        // not a failure — `loadConfig` is what reports a malformed one.
        return {};
    }
}

function writeUserConfig(path: string, values: SendfmConfig): void {
    const parsed = configSchema.safeParse(values);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new SendfmError(
            'USAGE',
            `That would make the config invalid: ${issue.path.join('.')} — ${issue.message}`,
        );
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(parsed.data, null, 4)}\n`, { mode: 0o600 });
}

function render(data: ConfigData, output: Output): void {
    const { theme } = output;
    switch (data.action) {
        case 'path':
            output.result(data.file);
            return;
        case 'get':
            output.result(
                data.value === undefined
                    ? ''
                    : typeof data.value === 'string'
                      ? data.value
                      : JSON.stringify(data.value),
            );
            return;
        case 'set':
        case 'unset':
            output.note(
                `${theme.success('✓')} ${data.key} ${data.action === 'set' ? '=' : 'unset'}`,
            );
            output.result(data.file);
            return;
        default: {
            if (data.sources.length === 0) {
                output.note(theme.muted('No config files found; using defaults.'));
            } else {
                for (const source of data.sources) {
                    output.note(theme.muted(`# ${source}`));
                }
            }
            const flat = flatten(data.values);
            if (flat.length === 0) {
                output.note(theme.muted('(empty)'));
                return;
            }
            for (const line of keyValueLines(flat)) {
                output.note(`  ${line}`);
            }
        }
    }
}

function flatten(value: unknown, prefix = ''): Array<[string, string]> {
    if (typeof value !== 'object' || value === null) {
        return [[prefix, JSON.stringify(value)]];
    }
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        flatten(child, prefix ? `${prefix}.${key}` : key),
    );
}

export default defineCommand({
    name: 'config',
    description: 'Show or change sendfm configuration',
    options: { ...globalOptions },
    handler: async ({ flags, positional }) => {
        const code = await runCommand(
            { name: 'config', flags: globalFlagsFrom(flags) },
            (session): CommandResult<ConfigData> => {
                const action = (positional[0] ?? 'list') as ConfigAction;
                const file = configFile();
                const key = positional[1];

                if (action === 'path') {
                    const data: ConfigData = {
                        action,
                        file,
                        sources: session.configSources,
                        values: session.config,
                    };
                    return { data, render: (output) => render(data, output) };
                }

                if (action === 'get') {
                    if (!key) {
                        throw new SendfmError(
                            'USAGE',
                            'Which key? e.g. `sendfm config get instance`',
                        );
                    }
                    const data: ConfigData = {
                        action,
                        file,
                        sources: session.configSources,
                        values: session.config,
                        key,
                        value: getPath(session.config, key),
                    };
                    return { data, render: (output) => render(data, output) };
                }

                if (action === 'set' || action === 'unset') {
                    if (!key) {
                        throw new SendfmError(
                            'USAGE',
                            `Which key? e.g. \`sendfm config ${action} instance${action === 'set' ? ' https://send.fm' : ''}\``,
                        );
                    }
                    const raw = positional[2];
                    if (action === 'set' && raw === undefined) {
                        throw new SendfmError('USAGE', `No value given for ${key}.`);
                    }
                    const next = setPath(
                        readUserConfig(file),
                        key,
                        action === 'set' ? coerceValue(raw as string) : undefined,
                    );
                    writeUserConfig(file, next);
                    const data: ConfigData = {
                        action,
                        file,
                        sources: [file],
                        values: next,
                        key,
                        value: action === 'set' ? getPath(next, key) : undefined,
                    };
                    return { data, render: (output) => render(data, output) };
                }

                const data: ConfigData = {
                    action: 'list',
                    file,
                    sources: session.configSources,
                    values: session.config,
                };
                return { data, render: (output) => render(data, output) };
            },
        );
        process.exitCode = code;
    },
});
