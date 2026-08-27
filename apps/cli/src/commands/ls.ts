/**
 * `sendfm ls` — what you have sent from this machine.
 *
 * Possible only because the CLI keeps state: the web app forgets a link's
 * owner token on reload, so it can never show you this.
 */

import { buildShareUrl } from '@bolter/protocol';
import { z } from 'zod';
import { defineCommand, option } from '../cli';
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
    /**
     * The complete, ready-to-share link, matching `up` and `resume` — the key
     * fragment included when the send was encrypted.
     *
     * Null, rather than a bare link, when the send was encrypted and the key
     * was not kept: there is no link left to reproduce, and printing one that
     * resolves to unopenable ciphertext would be worse than saying so.
     */
    url: string | null;
    encrypted: boolean;
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

export function toEntry(record: UploadRecord, now: number): ListEntry {
    const url =
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
        url,
        encrypted: Boolean(record.encrypted),
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        expiresInSeconds:
            record.expiresAt === null ? null : Math.floor((record.expiresAt - now) / 1000),
        downloadLimit: record.downloadLimit,
        status: record.status,
    };
}

/** The facts about one entry, in the order they answer "can I still use this?". */
export function describeEntry(entry: ListEntry): string {
    const expiry =
        entry.expiresInSeconds === null
            ? '—'
            : entry.expiresInSeconds <= 0
              ? 'expired'
              : formatExpiry(entry.expiresInSeconds);
    const downloads = entry.downloadLimit === 1 ? '1 download' : `${entry.downloadLimit} downloads`;
    return [formatBytes(entry.size), downloads, expiry]
        .concat(entry.encrypted ? ['encrypted'] : [])
        .concat(entry.status === 'pending' ? ['unfinished'] : [])
        .join('  ·  ');
}

/**
 * One block per send: what it is, then the link that opens it.
 *
 * The link sits directly under the entry it belongs to rather than in a
 * trailing block, because a list of bare URLs after a table is a puzzle — the
 * only thing tying a row to its link was that both happened to contain the
 * same id, which is also why the id was worth a column at all. It no longer
 * is: the link contains it, and for an encrypted send the link is the *only*
 * usable form, since the key lives in a fragment that cannot be reconstructed
 * from an id.
 */
export function renderList(data: ListData, output: Output): void {
    const { theme } = output;
    if (data.entries.length === 0) {
        output.note(theme.muted('Nothing sent from this machine yet.'));
        return;
    }

    /**
     * Where a link goes.
     *
     * Piped, it is the result and belongs on stdout — `sendfm ls > links.txt`
     * has to keep working. On a terminal nobody is parsing stdout, and
     * splitting the block across two streams would put its ordering at the
     * mercy of flush timing, so the whole thing goes to stderr in one piece.
     */
    const emitLink = output.stdoutIsTTY
        ? // Indented to sit with the block it belongs to.
          (url: string) => output.note(`  ${theme.link(url)}`)
        : // A result is a bare line: something downstream is reading it.
          (url: string) => output.result(url);

    const width = Math.max(40, (process.stderr.columns ?? 80) - 4);

    for (const [index, entry] of data.entries.entries()) {
        if (index > 0) {
            output.blank();
        }
        output.note(`  ${theme.bold(truncateMiddle(entry.name, width))}`);
        output.note(`  ${theme.muted(describeEntry(entry))}`);
        if (entry.url) {
            emitLink(entry.url);
        } else {
            // Encrypted, key not kept. Saying so beats printing a dead link.
            output.note(`  ${theme.muted('link unavailable — key was not stored')}`);
        }
    }

    if (data.pruned > 0) {
        output.blank();
        output.note(
            theme.muted(
                `  ${data.pruned} expired ${data.pruned === 1 ? 'entry' : 'entries'} forgotten.`,
            ),
        );
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
