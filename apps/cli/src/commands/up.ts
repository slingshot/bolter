/**
 * `sendfm up <paths…>` — send files.
 *
 * Encryption is **off by default**, matching the web app. The CLI and the web
 * UI are one product, and a flag that means the opposite thing in each is
 * worse than a default someone has to opt into.
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { buildShareUrl, Keychain } from '@bolter/protocol';
import { z } from 'zod';
import { defineCommand, option } from '../cli';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand, type Session } from '../core/session';
import { openState } from '../state/db';
import { ArchiveSource, FileSource, type Source } from '../transfer/source';
import { uploadSource } from '../transfer/upload';
import { shouldPromote } from '../ui/dashboard';
import { formatBytes, formatDuration, formatExpiry } from '../ui/format';
import type { Output } from '../ui/output';
import { createProgressReporter } from '../ui/progress';
import { symbols } from '../ui/theme';

export interface UpData {
    id: string;
    /**
     * The complete, ready-to-share link — including the `#key` fragment when
     * the send is encrypted. A caller reading `--json` hands this straight to
     * a person, so a link that needs assembling first is a link that gets
     * shared broken.
     */
    url: string;
    /** Present only for an encrypted send; this is the decryption key. */
    secret?: string;
    ownerToken: string;
    name: string;
    size: number;
    encrypted: boolean;
    archive: boolean;
    files: number;
    parts: number;
    retries: number;
    expiresInSeconds?: number;
    expiresAt?: number;
    downloads: number;
}

/**
 * Durations people actually type. Bare numbers are seconds, which is what the
 * API takes, so `--expire 3600` still means what it looks like.
 */
export function parseDuration(input: string): number {
    const match = /^(\d+)\s*([smhdw]?)$/i.exec(input.trim());
    if (!match) {
        throw new SendfmError('USAGE', `Cannot read "${input}" as a duration`, {
            hint: 'Try 30m, 24h, 7d, or a number of seconds.',
        });
    }
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit] ?? 1;
    return value * multiplier;
}

/** Expand directories depth-first, keeping paths relative to what was named. */
export async function expandInputs(
    paths: string[],
): Promise<Array<{ path: string; name: string }>> {
    const collected: Array<{ path: string; name: string }> = [];

    const walk = async (absolute: string, base: string): Promise<void> => {
        const info = await stat(absolute).catch(() => null);
        if (!info) {
            throw new SendfmError('FILE_NOT_FOUND', `No such file or directory: ${absolute}`);
        }
        if (info.isFile()) {
            collected.push({
                path: absolute,
                name: relative(base, absolute) || basename(absolute),
            });
            return;
        }
        if (!info.isDirectory()) {
            // Sockets, FIFOs and devices have no meaningful size, and a
            // multipart upload needs one before it starts.
            throw new SendfmError('USAGE', `Not a regular file or directory: ${absolute}`);
        }
        const entries = await readdir(absolute, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            await walk(join(absolute, entry.name), base);
        }
    };

    for (const input of paths) {
        const absolute = resolve(input);
        const info = await stat(absolute).catch(() => null);
        if (!info) {
            throw new SendfmError('FILE_NOT_FOUND', `No such file or directory: ${input}`);
        }
        // A named directory contributes its own name to the archive paths, so
        // `sendfm up photos/` produces photos/a.jpg rather than a bare a.jpg.
        await walk(absolute, info.isDirectory() ? resolve(absolute, '..') : absolute);
    }

    return collected;
}

async function buildSource(paths: string[]): Promise<Source> {
    const inputs = await expandInputs(paths);
    if (inputs.length === 0) {
        throw new SendfmError('USAGE', 'Nothing to send: that path contained no files.');
    }
    if (inputs.length === 1 && paths.length === 1) {
        const only = await stat(resolve(paths[0]));
        if (only.isFile()) {
            return FileSource.open(inputs[0].path);
        }
    }
    return ArchiveSource.open(inputs);
}

function render(data: UpData, output: Output): void {
    const { theme } = output;
    // Already complete — `UpData.url` carries the fragment.
    const share = data.url;

    output.blank();
    output.note(
        `${theme.success(symbols.ok)} ${theme.bold(data.name)} ${theme.muted(formatBytes(data.size))}` +
            (data.encrypted ? theme.muted(' · encrypted') : ''),
    );
    const expiry =
        data.expiresInSeconds === undefined
            ? ''
            : ` ${theme.muted('·')} expires ${formatExpiry(data.expiresInSeconds)}`;
    output.note(
        `  ${theme.muted(`${data.downloads} download${data.downloads === 1 ? '' : 's'}`)}${expiry}`,
    );
    if (data.retries) {
        output.note(theme.muted(`  ${data.retries} part retries`));
    }
    output.blank();

    // The link is the answer, so it is the only thing on stdout.
    output.result(share);
}

export default defineCommand({
    name: 'up',
    alias: ['upload', 'send'],
    description: 'Send one or more files and print a share link',
    options: {
        ...globalOptions,
        encrypt: option(z.coerce.boolean().default(false), {
            short: 'E',
            description: 'Encrypt end-to-end; the key goes in the link, never to the server',
            argumentKind: 'flag',
        }),
        expire: option(z.string().optional(), {
            short: 'e',
            description: 'How long the link lives, e.g. 30m, 24h, 7d',
        }),
        downloads: option(z.coerce.number().int().positive().optional(), {
            short: 'd',
            description: 'How many times it may be downloaded',
        }),
        concurrency: option(z.coerce.number().int().positive().max(64).optional(), {
            short: 'c',
            description: 'Upper bound on parallel part uploads',
        }),
        name: option(z.string().optional(), {
            description: 'Name for the archive when sending several files',
        }),
        tui: option(z.coerce.boolean().optional(), {
            description: 'Force the full-screen dashboard on or off (--no-tui to disable)',
            argumentKind: 'flag',
        }),
    },
    handler: async ({ flags, positional }) => {
        const code = await runCommand(
            { name: 'up', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<UpData>> => {
                if (positional.length === 0) {
                    throw new SendfmError('USAGE', 'Give me something to send.', {
                        hint: 'sendfm up notes.pdf',
                    });
                }
                const data = await performUpload(session, positional, flags);
                return { data, render: (output) => render(data, output) };
            },
        );
        process.exitCode = code;
    },
});

export async function performUpload(
    session: Session,
    paths: string[],
    flags: Record<string, unknown>,
): Promise<UpData> {
    const instance = await session.instance();
    const client = await session.client();
    const source = await buildSource(paths);

    const defaults = session.config.defaults ?? {};
    const encrypt = Boolean(flags.encrypt) || defaults.encrypt === true;
    const expireInput = (flags.expire as string | undefined) ?? defaults.expire;
    const timeLimit = expireInput ? parseDuration(expireInput) : instance.defaults.expireSeconds;
    const downloadLimit =
        (flags.downloads as number | undefined) ??
        defaults.downloads ??
        instance.defaults.downloads;

    // Check against the instance's own limits before transferring anything.
    // Failing after an hour of upload because the file was always too large is
    // the worst possible time to find out.
    if (source.plaintextSize > instance.limits.maxFileSize) {
        throw new SendfmError(
            'FILE_TOO_LARGE',
            `That is ${formatBytes(source.plaintextSize)}; ${instance.name} accepts up to ${formatBytes(instance.limits.maxFileSize)}.`,
            { details: { size: source.plaintextSize, limit: instance.limits.maxFileSize } },
        );
    }
    if (source.files.length > instance.limits.maxFilesPerArchive) {
        throw new SendfmError(
            'TOO_MANY_FILES',
            `That is ${source.files.length} files; ${instance.name} accepts up to ${instance.limits.maxFilesPerArchive}.`,
        );
    }
    if (timeLimit > instance.limits.maxExpireSeconds) {
        throw new SendfmError(
            'USAGE',
            `${instance.name} keeps files for at most ${formatDuration(instance.limits.maxExpireSeconds)}.`,
        );
    }
    if (downloadLimit > instance.limits.maxDownloads) {
        throw new SendfmError(
            'USAGE',
            `${instance.name} allows at most ${instance.limits.maxDownloads} downloads per link.`,
        );
    }

    const keychain = encrypt ? new Keychain() : null;
    // Decided before the first byte: a renderer that redraws cannot be swapped
    // in after something has already been printed.
    const promote = shouldPromote({
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        stderrIsTTY: Boolean(process.stderr.isTTY),
        columns: process.stdout.columns ?? 0,
        rows: process.stdout.rows ?? 0,
        json: session.output.mode === 'json',
        force: tuiPreference(session, flags),
        env: session.env,
        totalBytes: source.plaintextSize,
        threshold: instance.limits.multipartThreshold,
    });
    const reporter = createProgressReporter(session.output, source.displayName, {
        promote,
        encrypted: encrypt,
    });
    const state = openState(session.env);
    /** Set by onAllocated, which always runs before any part completes. */
    let fileId = '';
    // Secrets are stored so `ls` can reprint a working link and a resume needs
    // no key re-supplied. Opt out with `storeSecrets: false`.
    const storeSecrets = session.config.storeSecrets !== false;

    try {
        const outcome = await uploadSource({
            source,
            client,
            keychain,
            timeLimit,
            downloadLimit,
            maxConcurrency: (flags.concurrency as number | undefined) ?? defaults.concurrency,
            signal: session.signal,
            onProgress: (progress) => reporter.update(progress),
            onAllocated: (allocation) => {
                fileId = allocation.id;
                // Written before a byte moves: this is the first moment a
                // crash has something worth recovering.
                state.recordPending({
                    id: allocation.id,
                    instance: session.instanceOrigin,
                    url: '',
                    secret: keychain && storeSecrets ? keychain.secretKeyB64 : null,
                    ownerToken: allocation.ownerToken,
                    name: source.displayName,
                    size: allocation.uploadSize,
                    encrypted: encrypt ? 1 : 0,
                    archive: source.archiveFilename ? 1 : 0,
                    createdAt: Date.now(),
                    expiresAt: null,
                    downloadLimit,
                    uploadId: allocation.uploadId ?? null,
                    uploadToken: allocation.uploadToken ?? null,
                    partSize: allocation.partSize ?? null,
                    totalParts: allocation.totalParts ?? null,
                    sourcePaths: JSON.stringify(paths.map((p) => resolve(p))),
                });
            },
            onPartComplete: (part) => {
                state.recordPart({ fileId, ...part });
            },
        });

        state.markComplete(outcome.id, {
            url: outcome.url,
            size: outcome.size,
            expiresAt: outcome.expiresAt,
        });

        return {
            id: outcome.id,
            url: buildShareUrl({
                url: outcome.url,
                secret: keychain?.secretKeyB64,
                encrypted: encrypt,
            }),
            ...(keychain ? { secret: keychain.secretKeyB64 } : {}),
            ownerToken: outcome.ownerToken,
            name: (flags.name as string | undefined) ?? source.displayName,
            size: outcome.size,
            encrypted: encrypt,
            archive: Boolean(source.archiveFilename),
            files: source.files.length,
            parts: outcome.parts,
            retries: outcome.retries,
            expiresInSeconds: outcome.ttl,
            expiresAt: outcome.expiresAt,
            downloads: downloadLimit,
        };
    } finally {
        reporter.done();
        await source.close();
    }
}

/** `--tui` / `--no-tui`, then config, then "let the size decide". */
function tuiPreference(session: Session, flags: Record<string, unknown>): boolean | undefined {
    if (typeof flags.tui === 'boolean') {
        return flags.tui;
    }
    const configured = session.config.ui?.tui;
    if (configured === 'always') {
        return true;
    }
    if (configured === 'never') {
        return false;
    }
    return undefined;
}
