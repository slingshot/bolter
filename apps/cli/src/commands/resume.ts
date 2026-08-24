/**
 * `sendfm resume` — finish an upload that was interrupted.
 *
 * What makes this straightforward rather than delicate: the part plan is a
 * pure function of the file and the server's part size, so nothing about
 * "where we got to" needs storing. The only durable facts are which parts the
 * server already has and their ETags; everything else is recomputed.
 *
 * The source has to be the same file, though, and a file that changed since
 * the upload began would produce parts that do not match the ones already
 * stored — an object that assembles cleanly and decodes to garbage. Identity
 * is therefore checked, not assumed.
 */

import { stat } from 'node:fs/promises';
import { buildShareUrl, Keychain } from '@bolter/protocol';
import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand, type Session } from '../core/session';
import { openState, type UploadRecord } from '../state/db';
import { ArchiveSource, FileSource, type Source } from '../transfer/source';
import { uploadSource } from '../transfer/upload';
import { formatBytes } from '../ui/format';
import type { Output } from '../ui/output';
import { createProgressReporter } from '../ui/progress';
import { symbols } from '../ui/theme';

export interface ResumeData {
    id: string;
    name: string;
    url: string;
    secret?: string;
    partsAlreadyDone: number;
    partsTotal: number;
    bytesSkipped: number;
    size: number;
}

export interface ResumableSummary {
    id: string;
    name: string;
    size: number;
    partsDone: number;
    partsTotal: number;
    startedAt: number;
}

export function summarise(record: UploadRecord, partsDone: number): ResumableSummary {
    return {
        id: record.id,
        name: record.name,
        size: record.size,
        partsDone,
        partsTotal: record.totalParts ?? 1,
        startedAt: record.createdAt,
    };
}

/** Rebuild the source an interrupted upload was reading from. */
async function reopenSource(record: UploadRecord): Promise<Source> {
    const paths: string[] = record.sourcePaths ? JSON.parse(record.sourcePaths) : [];
    if (paths.length === 0) {
        throw new SendfmError('LOCAL_STATE', 'That upload did not record what it was sending.', {
            hint: 'Start it again with `sendfm up`.',
        });
    }
    for (const path of paths) {
        const info = await stat(path).catch(() => null);
        if (!info) {
            throw new SendfmError(
                'FILE_NOT_FOUND',
                `${path} is gone, so this upload cannot be finished.`,
                { hint: 'Start it again with `sendfm up` once the file is back.' },
            );
        }
    }
    if (paths.length === 1 && record.archive === 0) {
        return FileSource.open(paths[0]);
    }
    const { expandInputs } = await import('./up');
    return ArchiveSource.open(await expandInputs(paths));
}

export async function performResume(session: Session, record: UploadRecord): Promise<ResumeData> {
    const state = openState(session.env);
    const client = await session.client();
    const source = await reopenSource(record);

    // The plan is derived from the payload size, so a source of a different
    // size produces different part boundaries — and the parts already stored
    // would no longer line up with the ones still to send.
    const keychain = record.encrypted ? keychainFor(record) : null;
    const { calculateEncryptedSize } = await import('@bolter/protocol');
    const uploadSize = keychain
        ? calculateEncryptedSize(source.plaintextSize)
        : source.plaintextSize;
    if (uploadSize !== record.size) {
        throw new SendfmError(
            'LOCAL_STATE',
            `${source.displayName} is ${formatBytes(uploadSize)} now but was ` +
                `${formatBytes(record.size)} when the upload started.`,
            { hint: 'Start it again with `sendfm up`; the stored parts no longer match.' },
        );
    }

    const done = new Map(
        state
            .partsFor(record.id)
            .map((part) => [part.partNumber, { etag: part.etag, size: part.size }]),
    );
    const bytesSkipped = [...done.values()].reduce((n, part) => n + part.size, 0);

    const reporter = createProgressReporter(session.output, source.displayName);
    try {
        const outcome = await uploadSource({
            source,
            client,
            keychain,
            downloadLimit: record.downloadLimit,
            signal: session.signal,
            resumeFrom: done,
            existing: {
                id: record.id,
                ownerToken: record.ownerToken,
                uploadToken: record.uploadToken ?? undefined,
                uploadId: record.uploadId ?? undefined,
                partSize: record.partSize ?? undefined,
                totalParts: record.totalParts ?? undefined,
                uploadSize: record.size,
            },
            onProgress: (progress) => reporter.update(progress),
            onPartComplete: (part) => {
                state.recordPart({ fileId: record.id, ...part });
            },
        });

        state.markComplete(record.id, {
            url: outcome.url,
            size: outcome.size,
            expiresAt: outcome.expiresAt,
        });

        return {
            id: record.id,
            name: source.displayName,
            // Complete link, matching `up` — see UpData.url.
            url: buildShareUrl({
                url: outcome.url,
                secret: record.secret ?? undefined,
                encrypted: Boolean(record.secret),
            }),
            ...(record.secret ? { secret: record.secret } : {}),
            partsAlreadyDone: done.size,
            partsTotal: outcome.parts,
            bytesSkipped,
            size: outcome.size,
        };
    } finally {
        reporter.done();
        await source.close();
    }
}

function keychainFor(record: UploadRecord): Keychain {
    if (!record.secret) {
        // Without the key the remaining parts would be encrypted under a
        // different one, and the object would be undecryptable end to end.
        throw new SendfmError(
            'LOCAL_STATE',
            'That upload was encrypted and its key was not stored, so it cannot be finished.',
            { hint: 'Start it again with `sendfm up`.' },
        );
    }
    return new Keychain(record.secret);
}

function render(data: ResumeData, output: Output): void {
    const { theme } = output;
    output.blank();
    output.note(
        `${theme.success(symbols.ok)} ${theme.bold(data.name)} ${theme.muted(formatBytes(data.size))}`,
    );
    if (data.partsAlreadyDone > 0) {
        output.note(
            theme.muted(
                `  resumed at part ${data.partsAlreadyDone + 1}, skipping ${formatBytes(data.bytesSkipped)}`,
            ),
        );
    }
    output.blank();
    output.result(data.url);
}

export default defineCommand({
    name: 'resume',
    description: 'Finish an upload that was interrupted',
    options: {
        ...globalOptions,
        all: option(z.coerce.boolean().default(false), {
            description: 'Finish every unfinished upload',
            argumentKind: 'flag',
        }),
    },
    handler: async ({ flags, positional }) => {
        const code = await runCommand(
            { name: 'resume', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<ResumeData | ResumeData[]>> => {
                const state = openState(session.env);
                const pending = state.pending();

                if (pending.length === 0) {
                    throw new SendfmError('USAGE', 'Nothing to resume.', {
                        hint: 'Unfinished uploads appear in `sendfm ls --all`.',
                    });
                }

                if (flags.all) {
                    const results: ResumeData[] = [];
                    for (const record of pending) {
                        results.push(await performResume(session, record));
                    }
                    return {
                        data: results,
                        render: (output) => {
                            for (const result of results) {
                                render(result, output);
                            }
                        },
                    };
                }

                const target = positional[0];
                const record = target
                    ? (pending.find((r) => r.id === target) ??
                      (() => {
                          throw new SendfmError(
                              'USAGE',
                              `No unfinished upload with id "${target}".`,
                          );
                      })())
                    : pending[0];

                if (!target && pending.length > 1) {
                    session.warn(
                        'MULTIPLE_PENDING',
                        `${pending.length} unfinished uploads; resuming the most recent. Use --all for the rest.`,
                    );
                }

                const data = await performResume(session, record);
                return { data, render: (output) => render(data, output) };
            },
        );
        process.exitCode = code;
    },
});
