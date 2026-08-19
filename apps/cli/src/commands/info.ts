/**
 * `sendfm info <url|id>` — what is behind a share link, without downloading it
 * and without spending one of its downloads.
 *
 * Reading metadata never increments the counter; only `/download/complete`
 * does. That is what makes this safe to run against a one-download link.
 */

import {
    decodeMetadata,
    describeMetadata,
    Keychain,
    parseShareUrl,
    type UploadMetadata,
} from '@bolter/protocol';
import { defineCommand } from '@bunli/core';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand, type Session } from '../core/session';
import { formatBytes, formatExpiry, keyValueLines } from '../ui/format';
import type { Output } from '../ui/output';

export interface InfoData {
    id: string;
    instance: string;
    name: string;
    size: number;
    type: string;
    encrypted: boolean;
    archive: boolean;
    files: Array<{ name: string; size: number; type: string }>;
    downloads: { used: number | null; limit: number | null };
    expiresInSeconds: number;
    url: string;
}

/**
 * Accept either a full share link or a bare id.
 *
 * A bare id has no key, so an encrypted share can only report the facts the
 * server knows. That is still useful — "does this still exist, how long has it
 * got" — so it is allowed rather than refused.
 */
export function parseTarget(
    target: string,
    fallbackOrigin: string,
): { origin: string; id: string; secret: string } {
    if (/^https?:\/\//i.test(target)) {
        try {
            return parseShareUrl(target);
        } catch (error) {
            throw new SendfmError('INVALID_SHARE_URL', (error as Error).message, {
                hint: 'A share link looks like https://send.fm/download/<id>#<key>.',
            });
        }
    }
    const [id, secret = ''] = target.split('#');
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new SendfmError('INVALID_SHARE_URL', `"${target}" is not a share link or file id`, {
            hint: 'Pass the whole link, including everything after the #.',
        });
    }
    return { origin: fallbackOrigin, id, secret };
}

export async function collectInfo(session: Session, target: string): Promise<InfoData> {
    const instance = await session.instance();
    const { id, secret } = parseTarget(target, instance.web ?? session.instanceOrigin);
    const client = await session.client();
    const keychain = secret ? new Keychain(secret) : null;

    const raw = await client.getRawMetadata(id, keychain).catch((error: unknown) => {
        const status = (error as { status?: number }).status;
        if (status === 404 || status === 410) {
            throw new SendfmError('GONE', 'That link is no longer available.', {
                details: { id },
                hint: 'It may have expired or used up its downloads.',
            });
        }
        if (status === 401) {
            throw new SendfmError(
                secret ? 'INVALID_KEY' : 'MISSING_KEY',
                secret
                    ? 'The key in that link was rejected.'
                    : 'That file is encrypted and the link is missing its key.',
                { hint: 'Ask the sender for the complete link, including the part after #.' },
            );
        }
        throw error;
    });

    if (raw.encrypted && !keychain) {
        throw new SendfmError('MISSING_KEY', 'That file is encrypted and no key was supplied.', {
            hint: 'Ask the sender for the complete link, including the part after #.',
        });
    }

    let metadata: UploadMetadata;
    try {
        metadata = await decodeMetadata(raw.metadata, raw.encrypted ? keychain : null);
    } catch (error) {
        throw new SendfmError('INVALID_KEY', 'Could not decrypt that file’s metadata.', {
            cause: error,
            hint: 'The key in the link is wrong or truncated. Ask the sender to re-copy it.',
        });
    }

    const described = describeMetadata(metadata);
    return {
        id,
        instance: instance.name,
        name: described.name,
        size: raw.size ?? described.size,
        type: described.type,
        encrypted: raw.encrypted,
        archive: metadata.zipped === true,
        files: metadata.files ?? [],
        downloads: { used: raw.dl ?? null, limit: raw.dlimit ?? null },
        expiresInSeconds: raw.ttl,
        url: `${instance.web ?? session.instanceOrigin}/download/${id}`,
    };
}

function render(data: InfoData, output: Output): void {
    const { theme } = output;
    const downloads =
        data.downloads.used === null || data.downloads.limit === null
            ? theme.muted('unknown (instance predates this field)')
            : `${data.downloads.used} of ${data.downloads.limit}`;

    output.note(theme.bold(data.name));
    output.note('');
    for (const line of keyValueLines([
        ['id', data.id],
        ['instance', data.instance],
        ['size', formatBytes(data.size)],
        ['encrypted', data.encrypted ? 'yes' : 'no'],
        ['archive', data.archive ? `yes (${data.files.length} files)` : 'no'],
        ['downloads', downloads],
        ['expires', formatExpiry(data.expiresInSeconds)],
    ])) {
        const [key, ...rest] = line.split('  ');
        output.note(`  ${theme.muted(key)}  ${rest.join('  ')}`);
    }

    if (data.archive && data.files.length) {
        output.note('');
        output.note(theme.muted('  contents'));
        for (const file of data.files.slice(0, 20)) {
            output.note(`    ${file.name} ${theme.muted(formatBytes(file.size))}`);
        }
        if (data.files.length > 20) {
            output.note(theme.muted(`    … and ${data.files.length - 20} more`));
        }
    }

    // The link itself is the result, so it is the only thing on stdout.
    output.result(data.url);
}

export default defineCommand({
    name: 'info',
    description: 'Show what is behind a share link without downloading it',
    options: { ...globalOptions },
    handler: async ({ flags, positional }) => {
        const target = positional[0];
        const code = await runCommand(
            { name: 'info', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<InfoData>> => {
                if (!target) {
                    throw new SendfmError('USAGE', 'Give me a share link or a file id.', {
                        hint: 'sendfm info https://send.fm/download/<id>#<key>',
                    });
                }
                const data = await collectInfo(session, target);
                return { data, render: (output) => render(data, output) };
            },
        );
        process.exitCode = code;
    },
});
