/**
 * `sendfm set` — change a sent file's download limit.
 *
 * The limit is the only adjustable parameter: `/params/:id` accepts `dlimit`
 * and nothing else, so an expiry is fixed when the link is created.
 */

import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand } from '../core/session';
import { symbols } from '../ui/theme';
import { findRecord, instanceClient } from './_shared';

export interface SetData {
    id: string;
    downloads?: number;
}

export default defineCommand({
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
