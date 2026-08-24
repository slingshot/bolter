/**
 * `ls`, `rm`, `set` and `password` — the commands that exist because the CLI
 * has somewhere to keep things.
 *
 * The web app forgets your owner token the moment you reload, so a link it
 * gave you is a link you can never revoke. Persisting the token turns delete
 * and "change the download limit" into ordinary operations.
 */

import { buildShareUrl, Keychain } from '@bolter/protocol';
import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand, type Session } from '../core/session';
import { openState, type UploadRecord } from '../state/db';
import { formatBytes, formatExpiry, truncateMiddle } from '../ui/format';
import type { Output } from '../ui/output';
import { symbols } from '../ui/theme';

export interface ListEntry {
    id: string;
    name: string;
    size: number;
    instance: string;
    url: string;
    encrypted: boolean;
    /** Null when the secret was not stored, so no working link can be shown. */
    shareUrl: string | null;
    createdAt: number;
    expiresAt: number | null;
    expiresInSeconds: number | null;
    downloadLimit: number;
    status: 'pending' | 'complete';
}

export interface ListData {
    entries: ListEntry[];
    /** Rows dropped because their expiry had certainly passed. */
    pruned: number;
}

function toEntry(record: UploadRecord, now: number): ListEntry {
    const shareUrl =
        record.encrypted && !record.secret
            ? // The send was encrypted but the key was not kept, so there is no
              // link left to reproduce. Saying so beats printing a dead one.
              null
            : buildShareUrl({
                  url: record.url,
                  secret: record.secret ?? undefined,
                  encrypted: Boolean(record.encrypted),
              });
    return {
        id: record.id,
        name: record.name,
        size: record.size,
        instance: record.instance,
        url: record.url,
        encrypted: Boolean(record.encrypted),
        shareUrl,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        expiresInSeconds:
            record.expiresAt === null ? null : Math.floor((record.expiresAt - now) / 1000),
        downloadLimit: record.downloadLimit,
        status: record.status,
    };
}

function renderList(data: ListData, output: Output): void {
    const { theme } = output;
    if (data.entries.length === 0) {
        output.note(theme.muted('Nothing sent from this machine yet.'));
        return;
    }

    const widths = {
        id: Math.max(2, ...data.entries.map((e) => e.id.length)),
        name: Math.min(28, Math.max(4, ...data.entries.map((e) => e.name.length))),
        size: Math.max(4, ...data.entries.map((e) => formatBytes(e.size).length)),
    };

    for (const entry of data.entries) {
        const expiry =
            entry.expiresInSeconds === null
                ? theme.muted('—')
                : entry.expiresInSeconds <= 0
                  ? theme.muted('expired')
                  : formatExpiry(entry.expiresInSeconds);
        const flags = [
            entry.encrypted ? theme.muted('enc') : '   ',
            entry.status === 'pending' ? theme.warning('unfinished') : '',
        ]
            .filter(Boolean)
            .join(' ');
        output.note(
            `  ${theme.muted(entry.id.padEnd(widths.id))}  ` +
                `${truncateMiddle(entry.name, widths.name).padEnd(widths.name)}  ` +
                `${theme.secondary(formatBytes(entry.size).padStart(widths.size))}  ` +
                `${expiry}  ${flags}`,
        );
    }

    if (data.pruned > 0) {
        output.note(theme.muted(`\n  ${data.pruned} expired entries forgotten.`));
    }

    // The links are the machine-readable part, one per line.
    for (const entry of data.entries) {
        if (entry.shareUrl) {
            output.result(entry.shareUrl);
        }
    }
}

export const lsCommand = defineCommand({
    name: 'ls',
    alias: ['list'],
    description: 'Show what you have sent from this machine',
    options: {
        ...globalOptions,
        all: option(z.coerce.boolean().default(false), {
            short: 'a',
            description: 'Include uploads that never finished',
            argumentKind: 'flag',
        }),
        limit: option(z.coerce.number().int().positive().max(1000).default(50), {
            description: 'How many to show',
        }),
    },
    handler: ({ flags }) => {
        return runCommand(
            { name: 'ls', flags: globalFlagsFrom(flags) },
            (session): CommandResult<ListData> => {
                const state = openState(session.env);
                const pruned = state.prune();
                const now = Date.now();
                const entries = state
                    .list({
                        includePending: Boolean(flags.all),
                        limit: flags.limit as number,
                    })
                    .map((record) => toEntry(record, now));
                const data: ListData = { entries, pruned };
                return { data, render: (output) => renderList(data, output) };
            },
        ).then((code) => {
            process.exitCode = code;
        });
    },
});

/** Look a record up by id, or by the id inside a share link. */
function findRecord(target: string, env: NodeJS.ProcessEnv): UploadRecord {
    const state = openState(env);
    const id = target.includes('/download/')
        ? (target.split('/download/')[1]?.split(/[#?]/)[0] ?? target)
        : target.split('#')[0];
    const record = state.get(id);
    if (!record) {
        throw new SendfmError('LOCAL_STATE', `Nothing known about "${id}" on this machine.`, {
            hint: 'Only links sent from here can be managed. Run `sendfm ls` to see them.',
        });
    }
    return record;
}

export interface RemoveData {
    id: string;
    name: string;
    deletedRemotely: boolean;
    forgottenLocally: boolean;
}

export const rmCommand = defineCommand({
    name: 'rm',
    alias: ['delete'],
    description: 'Delete a file you sent, and forget it locally',
    options: {
        ...globalOptions,
        local: option(z.coerce.boolean().default(false), {
            description: 'Only forget it here; leave the file on the instance',
            argumentKind: 'flag',
        }),
    },
    handler: async ({ flags, positional }) => {
        const code = await runCommand(
            { name: 'rm', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<RemoveData>> => {
                const target = positional[0];
                if (!target) {
                    throw new SendfmError('USAGE', 'Which one? Pass an id or a share link.');
                }
                const record = findRecord(target, session.env);
                const state = openState(session.env);

                let deletedRemotely = false;
                if (!flags.local) {
                    const client = await instanceClient(session, record);
                    deletedRemotely = await client.deleteFile(record.id, record.ownerToken);
                    if (!deletedRemotely) {
                        // The token is the only proof of ownership, and it does
                        // not expire — so a rejection means the file is already
                        // gone, not that we lack permission.
                        session.warn(
                            'ALREADY_GONE',
                            'The instance would not delete it; it has probably expired already.',
                        );
                    }
                }
                state.forget(record.id);

                const data: RemoveData = {
                    id: record.id,
                    name: record.name,
                    deletedRemotely,
                    forgottenLocally: true,
                };
                return {
                    data,
                    render: (output) => {
                        output.note(
                            `${output.theme.success(symbols.ok)} ${record.name} ${output.theme.muted(
                                flags.local ? 'forgotten locally' : 'deleted',
                            )}`,
                        );
                        output.result(record.id);
                    },
                };
            },
        );
        process.exitCode = code;
    },
});

export interface SetData {
    id: string;
    downloads?: number;
}

export const setCommand = defineCommand({
    name: 'set',
    description: 'Change a sent file’s download limit',
    options: {
        ...globalOptions,
        downloads: option(z.coerce.number().int().positive().optional(), {
            short: 'd',
            description: 'New download limit',
        }),
    },
    handler: async ({ flags, positional }) => {
        const code = await runCommand(
            { name: 'set', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<SetData>> => {
                const target = positional[0];
                if (!target) {
                    throw new SendfmError('USAGE', 'Which one? Pass an id or a share link.');
                }
                if (flags.downloads === undefined) {
                    // `/params/:id` accepts dlimit and nothing else — expiry is
                    // fixed when the link is created and cannot be extended.
                    throw new SendfmError('USAGE', 'Nothing to change.', {
                        hint: 'The download limit is the only adjustable parameter: --downloads N',
                    });
                }
                const record = findRecord(target, session.env);
                const client = await instanceClient(session, record);
                const ok = await client.setParams(record.id, record.ownerToken, {
                    dlimit: flags.downloads as number,
                });
                if (!ok) {
                    throw new SendfmError('NOT_OWNER', 'The instance rejected that change.', {
                        hint: 'The file may have expired.',
                    });
                }
                const data: SetData = { id: record.id, downloads: flags.downloads as number };
                return {
                    data,
                    render: (output) => {
                        output.note(
                            `${output.theme.success(symbols.ok)} ${record.name} ${output.theme.muted(
                                `now allows ${data.downloads} downloads`,
                            )}`,
                        );
                        output.result(record.id);
                    },
                };
            },
        );
        process.exitCode = code;
    },
});

export interface PasswordData {
    id: string;
}

export const passwordCommand = defineCommand({
    name: 'password',
    description: 'Replace the auth key on an encrypted file you sent',
    options: { ...globalOptions },
    handler: async ({ flags, positional }) => {
        const code = await runCommand(
            { name: 'password', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<PasswordData>> => {
                const target = positional[0];
                if (!target) {
                    throw new SendfmError('USAGE', 'Which one? Pass an id or a share link.');
                }
                const record = findRecord(target, session.env);
                if (!record.encrypted) {
                    // Unencrypted files skip auth entirely, so an auth key on
                    // one would never be checked. Saying that is better than
                    // pretending it worked.
                    throw new SendfmError(
                        'USAGE',
                        'That file is not encrypted, so it has no auth key to change.',
                    );
                }
                if (!record.secret) {
                    throw new SendfmError(
                        'LOCAL_STATE',
                        'Its key was not stored here, so a new auth key cannot be derived.',
                    );
                }
                const client = await instanceClient(session, record);
                const keychain = new Keychain(record.secret);
                const ok = await client.setPassword(
                    record.id,
                    record.ownerToken,
                    await keychain.authKeyB64(),
                );
                if (!ok) {
                    throw new SendfmError('NOT_OWNER', 'The instance rejected that change.');
                }
                const data: PasswordData = { id: record.id };
                return {
                    data,
                    render: (output) => {
                        output.note(
                            `${output.theme.success(symbols.ok)} ${record.name} ${output.theme.muted('auth key replaced')}`,
                        );
                        output.result(record.id);
                    },
                };
            },
        );
        process.exitCode = code;
    },
});

/**
 * A client for the instance the record came from, not the configured default.
 *
 * Managing a file means talking to whichever instance holds it; using the
 * current default would send an owner token to a server that has no idea what
 * it refers to.
 */
async function instanceClient(session: Session, record: UploadRecord) {
    if (record.instance === session.instanceOrigin) {
        return session.client();
    }
    const { createBolterClient, discoverInstance } = await import('@bolter/protocol');
    const discovered = await discoverInstance(record.instance);
    return createBolterClient({ baseUrl: discovered.instance.api });
}
