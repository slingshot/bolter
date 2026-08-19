/**
 * Ordered finalization for the worker upload engine.
 *
 * The part-sequence rule itself lives in `@bolter/protocol/parts`, since every
 * Bolter client has to apply the same one. What stays here is the ordering:
 * validation runs against the **combined** persisted+new sequence before any
 * completion call [R15].
 *
 * Finalization is strictly ordered: `completeUpload` → `store.destroy()` →
 * `state.clearUpload()`. The server object exists once `completeUpload`
 * resolves, so the staged bytes go first and the durable engine state last —
 * a crash before the server call leaves a resumable upload, and a crash
 * after it leaves a replayable completion envelope, never OPFS garbage
 * without the state records that explain it.
 *
 * Worker-safe: no DOM globals.
 */

import { validatePartSequence } from '@bolter/protocol/parts';
import type { PartStore } from './part-store';
import type { CompletionEnvelope, EngineStateStore } from './state';

/** Task 9's `Pick<EngineDeps, 'completeUpload' | 'state' | 'store'>` shape. */
export interface FinalizeDeps {
    store: PartStore;
    state: EngineStateStore;
    completeUpload(
        envelope: CompletionEnvelope,
        parts: { PartNumber: number; ETag: string }[],
        actualSize: number,
    ): Promise<void>;
}

/**
 * Validate → `completeUpload` → `store.destroy()` →
 * `state.clearUpload(envelope.fileId)` — strictly in that order. Any
 * validation or completion failure leaves both the part store and the engine
 * state untouched.
 */
export async function finalizeUpload(
    envelope: CompletionEnvelope,
    etags: Map<number, string>,
    sizes: Map<number, number>,
    effectivePartSize: number,
    deps: FinalizeDeps,
): Promise<void> {
    const parts = [...sizes.entries()]
        .map(([partNumber, size]) => ({ partNumber, size }))
        .sort((a, b) => a.partNumber - b.partNumber);
    validatePartSequence(parts, effectivePartSize);

    let actualSize = 0;
    const completionParts = parts.map(({ partNumber, size }) => {
        const etag = etags.get(partNumber);
        if (!etag) {
            throw new Error(`part sequence invalid: part ${partNumber} has no ETag`);
        }
        actualSize += size;
        return { PartNumber: partNumber, ETag: etag };
    });

    await deps.completeUpload(envelope, completionParts, actualSize);
    await deps.store.destroy();
    await deps.state.clearUpload(envelope.fileId);
}
