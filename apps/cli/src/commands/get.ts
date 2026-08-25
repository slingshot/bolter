/**
 * `sendfm get <url|id>` — receive a file.
 *
 * The download counter is spent **after** the file is durably on disk, never
 * before. A refused save, a full disk or a truncated transfer therefore cannot
 * burn one of a link's limited downloads — which for a one-download link is
 * the difference between "try again" and "it is gone".
 */

import { access, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Keychain } from '@bolter/protocol';
import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand, type Session } from '../core/session';
import { downloadToFile } from '../transfer/download';
import { formatBytes } from '../ui/format';
import type { Output } from '../ui/output';
import { createProgressReporter } from '../ui/progress';
import { symbols } from '../ui/theme';
import { collectInfo, resolveTarget } from './info';

export interface GetData {
    id: string;
    path: string;
    name: string;
    bytes: number;
    encrypted: boolean;
    archive: boolean;
    extracted: boolean;
    ranges: number;
    retries: number;
    downloadsRemaining: number | null;
}

function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

/**
 * Where to put it.
 *
 * `--out` naming a directory means "into here"; naming anything else means
 * "as this". Guessing between the two by checking for a trailing slash is the
 * kind of cleverness that silently overwrites the wrong file.
 */
export async function resolveDestination(
    out: string | undefined,
    suggestedName: string,
): Promise<string> {
    if (!out) {
        return resolve(process.cwd(), suggestedName);
    }
    const info = await stat(out).catch(() => null);
    if (info?.isDirectory()) {
        return resolve(out, suggestedName);
    }
    return resolve(out);
}

function render(data: GetData, output: Output): void {
    const { theme } = output;
    output.blank();
    output.note(
        `${theme.success(symbols.ok)} ${theme.bold(data.name)} ${theme.muted(formatBytes(data.bytes))}` +
            (data.encrypted ? theme.muted(' · decrypted') : ''),
    );
    if (data.downloadsRemaining !== null) {
        output.note(
            theme.muted(
                `  ${data.downloadsRemaining} download${data.downloadsRemaining === 1 ? '' : 's'} left`,
            ),
        );
    }
    output.blank();
    // The path is the answer: `cd $(dirname $(sendfm get …))` should work.
    output.result(data.path);
}

export default defineCommand({
    name: 'get',
    alias: ['download'],
    description: 'Download a file from a share link',
    options: {
        ...globalOptions,
        out: option(z.string().optional(), {
            short: 'o',
            description: 'Where to write it: a directory to save into, or a filename',
        }),
        extract: option(z.coerce.boolean().default(false), {
            short: 'x',
            description: 'Unpack the archive after downloading, if it is one',
            argumentKind: 'flag',
        }),
        force: option(z.coerce.boolean().default(false), {
            short: 'f',
            description: 'Overwrite an existing file',
            argumentKind: 'flag',
        }),
        concurrency: option(z.coerce.number().int().positive().max(16).optional(), {
            short: 'c',
            description: 'Parallel ranged requests (default 4)',
        }),
    },
    handler: async ({ flags, positional }) => {
        const code = await runCommand(
            { name: 'get', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<GetData>> => {
                const target = positional[0];
                if (!target) {
                    throw new SendfmError('USAGE', 'Give me a share link.', {
                        hint: 'sendfm get https://send.fm/download/<id>#<key>',
                    });
                }
                const data = await performDownload(session, target, flags);
                return { data, render: (output) => render(data, output) };
            },
        );
        process.exitCode = code;
    },
});

export async function performDownload(
    session: Session,
    target: string,
    flags: Record<string, unknown>,
): Promise<GetData> {
    // `info` already resolves the instance, parses the link, authenticates and
    // decrypts the metadata — and spends nothing, because reading metadata
    // never touches the counter.
    const info = await collectInfo(session, target);
    // The same origin `info` just used, by the same rule — asking the session
    // for its default here would download from a different server than the one
    // whose metadata was read.
    const { origin, secret } = resolveTarget(session, target);
    const client = await session.clientFor(origin);
    const keychain = info.encrypted ? new Keychain(secret) : null;

    const destination = await resolveDestination(flags.out as string | undefined, info.name);
    if (!flags.force && (await exists(destination))) {
        throw new SendfmError('USAGE', `${destination} already exists.`, {
            hint: 'Pass --force to overwrite, or --out to choose another name.',
        });
    }
    await mkdir(dirname(destination), { recursive: true });

    const reporter = createProgressReporter(session.output, info.name);
    let outcome: Awaited<ReturnType<typeof downloadToFile>>;
    try {
        outcome = await downloadToFile({
            client,
            id: info.id,
            keychain,
            metadata: { files: info.files, zipped: info.archive },
            storedSize: info.size,
            destination,
            concurrency: flags.concurrency as number | undefined,
            signal: session.signal,
            onProgress: (progress) =>
                reporter.update({
                    uploaded: progress.received,
                    total: progress.total,
                    partsDone: progress.rangesDone,
                    partsTotal: progress.ranges,
                    inFlight: 0,
                    concurrency: 0,
                    retries: progress.retries,
                    rate: progress.rate,
                    eta: progress.eta,
                }),
        });
    } finally {
        reporter.done();
    }

    // Only now: the bytes are fsynced and renamed into place, so spending a
    // download credit is honest.
    const completed = await client.reportDownloadComplete(info.id, keychain);
    if (!completed) {
        session.warn(
            'COMPLETE_NOT_REPORTED',
            'The file was saved, but the instance did not record the download.',
        );
    }

    let extracted = false;
    if (flags.extract && info.archive) {
        extracted = extractArchive(destination);
    }

    return {
        id: info.id,
        path: destination,
        name: info.name,
        bytes: outcome.bytes,
        encrypted: info.encrypted,
        archive: info.archive,
        extracted,
        ranges: outcome.ranges,
        retries: outcome.retries,
        downloadsRemaining:
            info.downloads.limit === null || info.downloads.used === null
                ? null
                : Math.max(0, info.downloads.limit - info.downloads.used - 1),
    };
}

/**
 * Unpack next to the archive, into a directory named after it.
 *
 * Extraction is delegated to the system `unzip` rather than reimplemented: it
 * already refuses paths that escape the destination, and a second Zip Slip
 * implementation is a second chance to get it wrong.
 */
function extractArchive(archivePath: string): boolean {
    const destination = join(
        dirname(archivePath),
        archivePath
            .replace(/\.zip$/i, '')
            .split('/')
            .pop() || 'extracted',
    );
    const result = Bun.spawnSync(['unzip', '-q', '-o', archivePath, '-d', destination]);
    if (result.exitCode !== 0) {
        throw new SendfmError('LOCAL_STATE', 'Downloaded, but could not unpack the archive.', {
            details: { archivePath },
            hint: `Unpack it yourself: unzip ${archivePath}`,
        });
    }
    return true;
}
