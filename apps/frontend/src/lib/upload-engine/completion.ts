/**
 * Combined part-sequence validation and ordered finalization for the worker
 * upload engine.
 *
 * Validation runs against the **combined** persisted+new sequence before any
 * completion call [R15]: part numbers must be exactly contiguous `1..k`,
 * every non-trailing part must be exactly the effective part size and at
 * least the S3/R2 5 MiB minimum, and only the trailing part may be small or
 * oversized (it absorbs iOS lazy-transcode growth — the small-final-part
 * merge is dropped, so a small trailing part is simply legal).
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

import { UPLOAD_LIMITS } from '@bolter/shared';
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
 * Throws an Error whose message starts with `part sequence invalid` unless:
 * part numbers are exactly `1..k`; every part below `k` has
 * `size === effectivePartSize` and at least `MIN_PART_SIZE` (5,242,880)
 * bytes; part `k` may be any size >= 1, including above the effective size.
 */
export function validatePartSequence(
    parts: { partNumber: number; size: number }[],
    effectivePartSize: number,
): void {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const k = sorted.length;
    if (k === 0) {
        throw new Error('part sequence invalid: no parts');
    }
    for (let i = 0; i < k; i++) {
        const { partNumber } = sorted[i];
        if (partNumber !== i + 1) {
            throw new Error(
                `part sequence invalid: expected part ${i + 1}, got part ${partNumber} ` +
                    `(parts must be contiguous 1..${k})`,
            );
        }
    }
    for (const { partNumber, size } of sorted) {
        if (partNumber < k) {
            if (size !== effectivePartSize) {
                throw new Error(
                    `part sequence invalid: non-trailing part ${partNumber} is ${size} bytes, ` +
                        `expected exactly ${effectivePartSize}`,
                );
            }
            if (size < UPLOAD_LIMITS.MIN_PART_SIZE) {
                throw new Error(
                    `part sequence invalid: non-trailing part ${partNumber} is ${size} bytes, ` +
                        `below the ${UPLOAD_LIMITS.MIN_PART_SIZE}-byte S3/R2 minimum`,
                );
            }
        } else if (size < 1) {
            throw new Error(`part sequence invalid: trailing part ${partNumber} is empty`);
        }
    }
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
