/**
 * Helpers shared by the management commands.
 *
 * Separate from the commands themselves because bunli scans this directory and
 * expects exactly one default-exported command per file; anything else here
 * would be parsed as a malformed command.
 */

import { SendfmError } from '../core/errors';
import type { Session } from '../core/session';
import { openState, type UploadRecord } from '../state/db';

/** Look a record up by id, or by the id inside a share link. */
export function findRecord(target: string, env: NodeJS.ProcessEnv): UploadRecord {
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

/**
 * A client for the instance the record came from, not the configured default.
 *
 * Managing a file means talking to whichever instance holds it; using the
 * current default would send an owner token to a server that has no idea what
 * it refers to.
 */
export async function instanceClient(session: Session, record: UploadRecord) {
    if (record.instance === session.instanceOrigin) {
        return session.client();
    }
    const { createBolterClient, discoverInstance } = await import('@bolter/protocol');
    const discovered = await discoverInstance(record.instance);
    return createBolterClient({ baseUrl: discovered.instance.api });
}
