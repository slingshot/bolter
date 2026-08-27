/**
 * `sendfm password` — replace the auth key on an encrypted file.
 *
 * Encrypted files only: unencrypted ones skip auth entirely, so an auth key on
 * one would never be checked.
 */

import { Keychain } from '@bolter/protocol';
import { defineCommand } from '../cli';
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand } from '../core/session';
import { symbols } from '../ui/theme';
import { findRecord, instanceClient } from './_shared';

export interface PasswordData {
    id: string;
}

export default defineCommand({
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
