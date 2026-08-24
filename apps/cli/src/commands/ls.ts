/**
 * `sendfm ls` — what you have sent from this machine.
 *
 * Possible only because the CLI keeps state: the web app forgets a link's
 * owner token on reload, so it can never show you this.
 */

import { buildShareUrl } from '@bolter/protocol';
import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand } from '../core/session';
import { openState, type UploadRecord } from '../state/db';
import { formatBytes, formatExpiry, truncateMiddle } from '../ui/format';
import type { Output } from '../ui/output';

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

export default defineCommand({
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
