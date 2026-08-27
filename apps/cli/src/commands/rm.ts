/**
 * `sendfm rm` — delete something you sent.
 *
 * The owner token never expires and is the only proof of ownership, so a
 * rejection means the file is already gone rather than that we lack permission.
 */

import { z } from 'zod';
import { defineCommand, option } from '../cli';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand } from '../core/session';
import { openState } from '../state/db';
import { symbols } from '../ui/theme';
import { findRecord, instanceClient } from './_shared';

export interface RemoveData {
    id: string;
    name: string;
    deletedRemotely: boolean;
    forgottenLocally: boolean;
}

export default defineCommand({
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
