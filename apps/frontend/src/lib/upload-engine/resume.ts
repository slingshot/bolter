/**
 * Resume decision tree for the worker upload engine, evaluated in spec order:
 *
 * 1. `replay-complete` — the completion envelope plus a full contiguous
 *    uploaded+ETag list is durable: replay `/upload/complete` directly
 *    (idempotent via authKey). Covers the lost-response window where the
 *    backend already completed the multipart and deleted its metadata, so
 *    `/resume` would 404 [R7].
 * 2. `finish-staged` — production reached EOF and every produced part is
 *    staged (or already uploaded): finish uploads and completion with no
 *    source re-pick, for any source kind including multi-file and zip (the
 *    crash-window promise).
 * 3. `need-source` — production is incomplete: a single-file resume re-picks
 *    its source (persisted-handle or manual flow); multi-file is start-fresh
 *    only, because zip production cannot restart mid-archive.
 * 4. `unrecoverable` — no lease or envelope: nothing durable enough to act on.
 *
 * `planResume` is a pure function over the four persisted record shapes;
 * `executeResume` loads them from the engine state store, plans, and runs the
 * chosen branch through the same ordered finalization as a live run.
 *
 * Worker-safe: no DOM globals.
 */

import { getConcurrentUploads, isRetryableError } from '@/lib/upload-shared';
import { finalizeUpload } from './completion';
import { type EngineDeps, type EngineResult, runEngine } from './engine';
import type { EngineJob } from './protocol';
import type {
    CompletionEnvelope,
    EngineLease,
    EnginePartRecord,
    ProducerCheckpoint,
} from './state';

export type ResumePlan =
    | { action: 'replay-complete' } // envelope + full contiguous etag list [R7]
    | { action: 'finish-staged' } // all remaining bytes staged; no source needed
    | { action: 'need-source'; kind: 'single' | 'multi' } // single → re-pick/handle; multi → start-fresh only
    | { action: 'unrecoverable' }; // no lease/envelope

/** The upload needs its source re-picked before it can resume (`kind:
 * 'single'`) or must start fresh (`kind: 'multi'`) — routing data for the
 * resume UI. */
export class ResumeNeedsSourceError extends Error {
    readonly kind: 'single' | 'multi';

    constructor(kind: 'single' | 'multi') {
        super(
            kind === 'multi'
                ? 'resume needs its source: multi-file production is incomplete — start fresh'
                : 'resume needs its source: re-pick the file to continue',
        );
        this.name = 'ResumeNeedsSourceError';
        this.kind = kind;
    }
}

export function planResume(
    lease: EngineLease | undefined,
    envelope: CompletionEnvelope | undefined,
    checkpoint: ProducerCheckpoint | undefined,
    parts: EnginePartRecord[],
): ResumePlan {
    if (!lease || !envelope) {
        return { action: 'unrecoverable' };
    }
    // Production is complete only once EOF is checkpointed — and, for
    // encrypted uploads, only once the mandatory final ECE record is out:
    // without it the staged ciphertext is truncated and unfinishable.
    if (checkpoint?.eofReached && (checkpoint.finalRecordEmitted || !envelope.encrypted)) {
        const producedCount = checkpoint.nextPartNumber - 1;
        if (producedCount >= 1) {
            if (coversAllParts(parts, producedCount, (p) => p.uploaded && p.etag !== undefined)) {
                return { action: 'replay-complete' };
            }
            if (
                coversAllParts(
                    parts,
                    producedCount,
                    (p) => p.staged || (p.uploaded && p.etag !== undefined),
                )
            ) {
                return { action: 'finish-staged' };
            }
        }
    }
    return {
        action: 'need-source',
        kind: envelope.manifest.length > 1 ? 'multi' : 'single',
    };
}

/** True when parts `1..producedCount` all have a record matching `predicate`. */
function coversAllParts(
    parts: EnginePartRecord[],
    producedCount: number,
    predicate: (p: EnginePartRecord) => boolean,
): boolean {
    const byNumber = new Map(parts.map((p) => [p.partNumber, p]));
    for (let partNumber = 1; partNumber <= producedCount; partNumber++) {
        const record = byNumber.get(partNumber);
        if (!record || !predicate(record)) {
            return false;
        }
    }
    return true;
}

/**
 * Load persisted state for `fileId`, plan, and run the chosen branch. The
 * replay branch calls `/upload/complete` directly with the persisted ETags
 * (through the same ordered finalization as a live run); `finish-staged`
 * reconstructs an `EngineJob` from the lease + envelope and re-enters
 * `runEngine`, whose EOF checkpoint skips production entirely. `need-source`
 * and `unrecoverable` reject — the caller owns re-pick / start-fresh UI.
 */
export async function executeResume(
    fileId: string,
    deps: EngineDeps,
    cancel: AbortSignal,
): Promise<EngineResult> {
    if (cancel.aborted) {
        throw new Error('Upload cancelled');
    }
    const [lease, envelope, checkpoint, parts] = await Promise.all([
        deps.state.getLease(fileId),
        deps.state.getEnvelope(fileId),
        deps.state.getCheckpoint(fileId),
        deps.state.getParts(fileId),
    ]);
    const plan = planResume(lease, envelope, checkpoint, parts);

    if (plan.action === 'unrecoverable' || !lease || !envelope) {
        const error = new Error(
            `upload ${fileId} is not resumable: no engine lease or completion envelope`,
        );
        deps.onEvent({ type: 'error', message: error.message, retryable: false });
        throw error;
    }
    if (plan.action === 'need-source') {
        const error = new ResumeNeedsSourceError(plan.kind);
        deps.onEvent({ type: 'error', message: error.message, retryable: false });
        throw error;
    }
    if (plan.action === 'replay-complete') {
        try {
            return await replayComplete(envelope, parts, deps);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            deps.onEvent({
                type: 'error',
                message: error.message,
                retryable: isRetryableError(error),
            });
            throw error;
        }
    }
    // finish-staged: runEngine owns event emission from here.
    return finishStaged(lease, envelope, parts, deps, cancel);
}

/**
 * Replay `/upload/complete` from persisted ETags [R7]. `finalizeUpload`
 * re-validates the combined sequence and keeps the ordered teardown
 * (completeUpload → store.destroy → state.clearUpload), so a rejected replay
 * leaves every durable record intact for the next attempt.
 */
async function replayComplete(
    envelope: CompletionEnvelope,
    parts: EnginePartRecord[],
    deps: EngineDeps,
): Promise<EngineResult> {
    const etags = new Map<number, string>();
    const sizes = new Map<number, number>();
    let actualSize = 0;
    for (const part of parts) {
        sizes.set(part.partNumber, part.size);
        actualSize += part.size;
        if (part.etag !== undefined) {
            etags.set(part.partNumber, part.etag);
        }
    }
    await finalizeUpload(envelope, etags, sizes, effectivePartSizeOf(parts), {
        completeUpload: (env, completionParts, size) =>
            deps.completeUpload(env, completionParts, size),
        state: deps.state,
        store: deps.store,
    });
    deps.onEvent({ type: 'done', actualSize });
    return { actualSize };
}

/**
 * Rebuild an `EngineJob` from the persisted lease + envelope and re-enter
 * `runEngine`: the EOF checkpoint makes it skip production, upload the staged
 * remainder (reusing persisted ETags), and finalize. Pre-signed URLs are
 * always refreshed — the originals are gone with the crashed run and likely
 * expired anyway.
 */
async function finishStaged(
    lease: EngineLease,
    envelope: CompletionEnvelope,
    parts: EnginePartRecord[],
    deps: EngineDeps,
    cancel: AbortSignal,
): Promise<EngineResult> {
    const partUrls = await deps.refreshPartUrls(lease.fileId, lease.uploadToken);
    const job: EngineJob = {
        fileId: lease.fileId,
        uploadId: lease.uploadId,
        uploadToken: lease.uploadToken,
        ownerToken: lease.ownerToken,
        partUrls,
        partSize: effectivePartSizeOf(parts),
        encrypted: envelope.encrypted,
        secretKeyB64: envelope.secretKeyB64,
        maxConcurrent: getConcurrentUploads(envelope.expectedSize),
        declaredTotalSize: envelope.expectedSize,
        // Production already reached EOF, so the producer never runs — an
        // empty placeholder source satisfies the job shape without bytes.
        source: { kind: 'blob', blob: new Blob([]) },
    };
    return runEngine(job, envelope, deps, cancel);
}

/**
 * The effective (nominal) part size of a persisted sequence: every
 * non-trailing part was cut at exactly this size, so the first part carries
 * it. A single-part sequence is all-trailing — validation ignores the
 * effective size there, so its own size serves.
 */
function effectivePartSizeOf(parts: EnginePartRecord[]): number {
    return parts[0]?.size ?? 0;
}
