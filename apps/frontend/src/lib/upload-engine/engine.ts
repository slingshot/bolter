/**
 * `runEngine` — the transport-agnostic upload-engine pipeline core:
 * producer → stager → concurrent uploaders → validated completion, wired
 * through injected deps so the whole flow is unit-testable with fakes.
 *
 * Durable ordering: the lease is written first, then the completion envelope
 * [R3][R12], then production begins. A persisted producer checkpoint resumes
 * slice-backed (file/blob) sources from the exact byte/record boundary it
 * describes; already-uploaded parts contribute their persisted ETags and
 * already-staged parts feed straight into the upload queue, so a crashed run
 * continues instead of restarting. Zip production is crash-window only — a
 * mid-production zip checkpoint is not resumable [spec: multi-file resume].
 *
 * Cancellation [R6] is acknowledged and ordered: unwind the pipeline, call
 * the authenticated server-side abort, emit `cancelled`, then destroy the
 * part store and clear engine state. Failures emit `error` with a
 * `retryable` flag and leave every durable record intact for resume.
 *
 * Worker-safe: no DOM globals.
 */

import { createEncryptionStream, ECE_RECORD_SIZE, Keychain } from '@/lib/crypto';
import { isRetryableError, retryDelayMs as sharedRetryDelayMs } from '@/lib/upload-shared';
import { finalizeUpload } from './completion';
import { type PartStore, PartStoreQuotaError } from './part-store';
import { createSliceProducer, createZipProducer, type ProducerChunk } from './producer';
import type { EngineFailureStage, EngineJob, WorkerToClient } from './protocol';
import { runStager } from './stager';
import type { CompletionEnvelope, EngineStateStore, ProducerCheckpoint } from './state';
import type { UploadPartResult } from './uploader';
import { runUploaders } from './uploader';

export type { UploadPartResult } from './uploader';

export interface EngineDeps {
    store: PartStore;
    state: EngineStateStore;
    uploadPart(
        url: string,
        body: Blob,
        hooks: { onProgress(loaded: number): void; signal: AbortSignal },
    ): Promise<UploadPartResult>;
    completeUpload(
        envelope: CompletionEnvelope,
        parts: { PartNumber: number; ETag: string }[],
        actualSize: number,
    ): Promise<void>;
    refreshPartUrls(fileId: string, uploadToken?: string): Promise<string[]>;
    abortUpload(fileId: string, uploadToken?: string): Promise<void>;
    now(): number; // wall clock (Date.now)
    isOnline(): boolean; // fed by connectivity relay
    onEvent(e: WorkerToClient): void;
}

export interface EngineResult {
    actualSize: number;
}

/** Optional knobs for deterministic tests; production callers omit this. */
export interface EngineTuning {
    stallMs?: number;
    maxAttemptsPerPart?: number;
    retryDelayMs?: (attempt: number) => number;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    producerChunkBytes?: number;
}

/** Staged-and-ready parts the stager may run ahead of the uploaders. */
const WINDOW_SLACK = 2;

// ---------------------------------------------------------------------------
// Failure-stage tagging [R16]: errors are tagged where the pipeline knows
// which leg they came from, and the tag rides the error object to the single
// place that emits the terminal `error` event. First tag wins — an uploader
// failure that unwinds the stager must not be re-labeled 'staging'.
// ---------------------------------------------------------------------------

const failureStages = new WeakMap<Error, EngineFailureStage>();

/** Tag `error` with the pipeline stage it escaped from (first tag wins). */
export function tagFailureStage(error: Error, stage: EngineFailureStage): Error {
    if (!failureStages.has(error)) {
        failureStages.set(error, stage);
    }
    return error;
}

/** The stage `error` was tagged with, if any. */
export function failureStageOf(error: Error): EngineFailureStage | undefined {
    return failureStages.get(error);
}

export async function runEngine(
    job: EngineJob,
    envelope: CompletionEnvelope,
    deps: EngineDeps,
    cancel: AbortSignal,
    tuning?: EngineTuning,
): Promise<EngineResult> {
    let result: EngineResult;
    try {
        result = await runPipeline(job, envelope, deps, cancel, tuning);
    } catch (err) {
        if (cancel.aborted) {
            // Ordered cancel ack [R6]: server-side abort → `cancelled` event →
            // local teardown. The pipeline has fully unwound by the time the
            // error reaches here, so no write can land after the clear.
            await cancelCleanup(job, deps);
            throw new Error('Upload cancelled');
        }
        const error = toError(err);
        deps.onEvent({
            type: 'error',
            message: error.message,
            retryable: isRetryableEngineError(error),
            stage: failureStageOf(error) ?? 'engine',
        });
        throw error;
    }
    deps.onEvent({ type: 'done', actualSize: result.actualSize });
    return result;
}

async function runPipeline(
    job: EngineJob,
    envelope: CompletionEnvelope,
    deps: EngineDeps,
    cancel: AbortSignal,
    tuning?: EngineTuning,
): Promise<EngineResult> {
    const totalParts = job.partUrls.length;
    if (totalParts === 0) {
        throw new Error('engine job has no part URLs');
    }
    const secretKeyB64 = job.encrypted ? job.secretKeyB64 : undefined;
    if (job.encrypted && !secretKeyB64) {
        throw new Error('encrypted engine job is missing its secret key');
    }
    throwIfCancelled(cancel);

    // Durable ordering: lease before any part-store write [R12], envelope as
    // soon as its inputs exist [R3] — a source-free resume has no File to
    // rebuild completion metadata from. The main thread may have written a
    // lease carrying persisted source handles before starting this job [R13]
    // (the job itself cannot carry them across the worker boundary contract),
    // so an existing lease's handle fields are preserved, never clobbered.
    const existingLease = await deps.state.getLease(job.fileId);
    await deps.state.putLease({
        fileId: job.fileId,
        uploadId: job.uploadId,
        uploadToken: job.uploadToken,
        ownerToken: job.ownerToken,
        createdAt: deps.now(),
        engineVersion: 1,
        ...(existingLease?.handles !== undefined && { handles: existingLease.handles }),
        ...(existingLease?.handleFacts !== undefined && {
            handleFacts: existingLease.handleFacts,
        }),
    });
    await deps.state.putEnvelope(envelope);

    // Persisted progress from an interrupted run (both empty on a fresh one).
    const persisted = await deps.state.getParts(job.fileId);
    const checkpoint = await deps.state.getCheckpoint(job.fileId);
    const production = planProduction(job, checkpoint);

    const sizes = new Map<number, number>();
    const persistedEtags = new Map<number, string>();
    let uploadedBytesBaseline = 0;
    const alreadyStaged: { partNumber: number; size: number }[] = [];
    // A crash between the stager's putPart(staged) and its checkpoint write
    // leaves the checkpoint still naming that part as next-to-produce. Active
    // production re-produces every part from the checkpoint onward, so stale
    // staged records in that range must not also feed the upload queue — the
    // same part queued twice races the winner's delete-after-upload against
    // the duplicate's readPart, failing the run non-retryably [R4][R5].
    const reproducedFrom = production.produce
        ? production.basePartNumber + 1
        : Number.POSITIVE_INFINITY;
    for (const part of persisted) {
        if (part.uploaded && part.etag) {
            sizes.set(part.partNumber, part.size);
            persistedEtags.set(part.partNumber, part.etag);
            uploadedBytesBaseline += part.size;
        } else if (part.staged && part.partNumber < reproducedFrom) {
            sizes.set(part.partNumber, part.size);
            alreadyStaged.push({ partNumber: part.partNumber, size: part.size });
        }
        // Anything else (unstaged demotions, or staged records the producer
        // will re-produce) contributes nothing here — re-production rewrites
        // the record and reports its size through onPartStaged.
    }

    // Pull queue from stager to uploaders: persisted staged parts first, then
    // parts as they commit; closed (null) once production has finished.
    const queue = new AsyncQueue<{ partNumber: number; size: number }>();
    for (const item of alreadyStaged) {
        queue.push(item);
    }

    // Rolling-window slot accounting: a part holds a window slot from the
    // moment the stager commits it until an uploader *picks it up*, not until
    // its bytes are deleted. Slots held for a whole transfer left only
    // WINDOW_SLACK parts staged-and-ready in front of `maxConcurrent`
    // uploaders, so every convoy of simultaneous part completions idled an
    // uploader for a full staging latency. Residency stays bounded — the
    // window, plus the parts in flight, plus whatever is awaiting its detached
    // delete.
    let releaseCredits = 0;
    const releaseWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];
    const releaseSlot = () => {
        const waiter = releaseWaiters.shift();
        if (waiter) {
            waiter.resolve();
        } else {
            releaseCredits += 1;
        }
    };

    // `stop` unwinds the stager (producer + window waits) on cancel or on a
    // terminal uploader failure. The producer *throws* on stop rather than
    // reporting EOF, so an interrupted run can never commit a truncated part
    // or an eof-marked checkpoint.
    let stopReason: Error | undefined;
    const stop = new AbortController();
    const stopStaging = (reason: Error) => {
        if (stop.signal.aborted) {
            return;
        }
        stopReason = reason;
        stop.abort();
        for (const waiter of releaseWaiters.splice(0)) {
            waiter.reject(reason);
        }
    };
    const stopError = () => stopReason ?? new Error('Upload cancelled');
    const onCancel = () => stopStaging(new Error('Upload cancelled'));
    cancel.addEventListener('abort', onCancel, { once: true });

    const partReleased = (): Promise<void> => {
        if (stop.signal.aborted) {
            return Promise.reject(stopError());
        }
        if (releaseCredits > 0) {
            releaseCredits -= 1;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            releaseWaiters.push({ resolve, reject });
        });
    };

    const base = production.basePartNumber;

    /**
     * Hand the next staged part to an uploader, freeing its window slot as it
     * goes. Parts staged by an *earlier* run (`partNumber <= base`) never
     * occupied a slot in this stager's window, so picking one up must not
     * credit one either — that would let the window run wider than its size on
     * every resume.
     */
    const takeNextPart = async (): Promise<{ partNumber: number; size: number } | null> => {
        const next = await queue.next();
        if (next && next.partNumber > base) {
            releaseSlot();
        }
        return next;
    };

    const stagerRun = (
        production.produce
            ? runStager(
                  cancellableProducer(
                      buildProducer(job, production, tuning),
                      stop.signal,
                      stopError,
                  ),
                  {
                      fileId: job.fileId,
                      partSize: job.partSize,
                      totalParts: totalParts - base,
                      windowSize: Math.max(1, job.maxConcurrent) + WINDOW_SLACK,
                      store: offsetPartStore(deps.store, base),
                      state: offsetPartState(deps.state, base),
                      encrypt: secretKeyB64
                          ? createEncryptionStream(
                                new Keychain(secretKeyB64),
                                production.eceCounter,
                            )
                          : undefined,
                      checkpointOf: (sourceOffset, nextLocalPart, eof) => {
                          const realOffset = production.startOffset + sourceOffset;
                          return {
                              fileId: job.fileId,
                              nextPartNumber: base + nextLocalPart,
                              sourceOffset: realOffset,
                              // Exact at non-eof boundaries (the offset is a record
                              // multiple there); at eof production is complete and
                              // the counter is never used to restart.
                              eceCounter: job.encrypted
                                  ? Math.ceil(realOffset / ECE_RECORD_SIZE)
                                  : 0,
                              eofReached: eof,
                              finalRecordEmitted: eof,
                          };
                      },
                      onPartStaged: (localPart, size) => {
                          const partNumber = base + localPart;
                          sizes.set(partNumber, size);
                          queue.push({ partNumber, size });
                      },
                      partReleased,
                  },
              )
            : Promise.resolve({ partsProduced: 0, actualSize: 0 })
    ).then(
        (r) => {
            queue.close();
            return r;
        },
        (err: unknown) => {
            // Close so uploaders drain in-flight parts and settle — progress
            // made while staging failed stays persisted for resume.
            queue.close();
            const error = toError(err);
            // First tag wins: an uploader failure that unwound the stager
            // keeps its 'uploader' stage.
            throw tagFailureStage(
                error,
                error instanceof PartStoreQuotaError ? 'stager-quota' : 'staging',
            );
        },
    );

    const uploaderRun = runUploaders(takeNextPart, {
        urls: job.partUrls,
        maxConcurrent: job.maxConcurrent,
        store: deps.store,
        state: deps.state,
        fileId: job.fileId,
        uploadPart: (url, body, hooks) => deps.uploadPart(url, body, hooks),
        refreshUrls: () => deps.refreshPartUrls(job.fileId, job.uploadToken),
        now: () => deps.now(),
        isOnline: () => deps.isOnline(),
        stallMs: tuning?.stallMs,
        maxAttemptsPerPart: tuning?.maxAttemptsPerPart,
        retryDelayMs: tuning?.retryDelayMs ?? sharedRetryDelayMs,
        onProgress: (sent, atMs) =>
            deps.onEvent({
                type: 'progress',
                bytesSent: uploadedBytesBaseline + sent,
                totalBytes: job.declaredTotalSize,
                atMs,
            }),
        onRetry: () => deps.onEvent({ type: 'retry' }),
        signal: cancel,
        setTimeoutFn: tuning?.setTimeoutFn,
    }).catch((err: unknown) => {
        const error = tagFailureStage(toError(err), 'uploader');
        stopStaging(error);
        throw error;
    });

    let stagerOutcome: PromiseSettledResult<{ partsProduced: number; actualSize: number }>;
    let uploaderOutcome: PromiseSettledResult<Map<number, string>>;
    try {
        // Both branches always settle before anything else happens (cleanup,
        // error emission, finalize) — no write can race past this point.
        [stagerOutcome, uploaderOutcome] = await Promise.allSettled([stagerRun, uploaderRun]);
    } finally {
        cancel.removeEventListener('abort', onCancel);
    }
    throwIfCancelled(cancel);
    if (uploaderOutcome.status === 'rejected') {
        throw toError(uploaderOutcome.reason);
    }
    if (stagerOutcome.status === 'rejected') {
        throw toError(stagerOutcome.reason);
    }

    const etags = new Map(persistedEtags);
    for (const [partNumber, etag] of uploaderOutcome.value) {
        etags.set(partNumber, etag);
    }

    try {
        await finalizeUpload(envelope, etags, sizes, job.partSize, {
            completeUpload: (env, parts, actualSize) => deps.completeUpload(env, parts, actualSize),
            state: deps.state,
            store: deps.store,
        });
    } catch (err) {
        throw tagFailureStage(toError(err), 'completion');
    }

    let actualSize = 0;
    for (const size of sizes.values()) {
        actualSize += size;
    }
    return { actualSize };
}

interface ProductionPlan {
    produce: boolean;
    basePartNumber: number; // parts already produced before this run
    startOffset: number; // plaintext source offset production restarts from
    eceCounter: number; // next ECE record sequence number
}

function planProduction(
    job: EngineJob,
    checkpoint: ProducerCheckpoint | undefined,
): ProductionPlan {
    if (!checkpoint) {
        return { produce: true, basePartNumber: 0, startOffset: 0, eceCounter: 0 };
    }
    if (checkpoint.eofReached) {
        // Production finished in a previous run — every remaining byte is
        // already staged; only uploads and completion are left.
        return {
            produce: false,
            basePartNumber: checkpoint.nextPartNumber - 1,
            startOffset: checkpoint.sourceOffset,
            eceCounter: checkpoint.eceCounter,
        };
    }
    if (job.source.kind === 'zip') {
        // The zip stream cannot re-wind into a half-written archive — zip
        // resume is crash-window only (Task 10 routes this to start-fresh).
        throw new Error('zip upload cannot resume mid-production');
    }
    return {
        produce: true,
        basePartNumber: checkpoint.nextPartNumber - 1,
        startOffset: checkpoint.sourceOffset,
        eceCounter: checkpoint.eceCounter,
    };
}

function buildProducer(
    job: EngineJob,
    production: ProductionPlan,
    tuning?: EngineTuning,
): AsyncGenerator<ProducerChunk> {
    const chunkOpts = tuning?.producerChunkBytes ? { chunkBytes: tuning.producerChunkBytes } : {};
    switch (job.source.kind) {
        case 'file':
            return createSliceProducer(job.source.file, {
                ...chunkOpts,
                startOffset: production.startOffset,
            });
        case 'blob':
            return createSliceProducer(job.source.blob, {
                ...chunkOpts,
                startOffset: production.startOffset,
            });
        case 'zip':
            return createZipProducer(job.source.files, job.source.names, chunkOpts);
    }
}

/**
 * Wrap a producer so an engine stop *throws* out of the stager instead of
 * looking like EOF — a fake EOF would let the stager commit a truncated part
 * and an eof-marked checkpoint, poisoning any later resume.
 */
async function* cancellableProducer(
    inner: AsyncGenerator<ProducerChunk>,
    stopSignal: AbortSignal,
    stopError: () => Error,
): AsyncGenerator<ProducerChunk> {
    try {
        while (true) {
            if (stopSignal.aborted) {
                throw stopError();
            }
            const { done, value } = await inner.next();
            if (done) {
                return;
            }
            yield value;
        }
    } finally {
        await inner.return(undefined).then(
            () => undefined,
            () => undefined,
        );
    }
}

/**
 * The stager numbers parts from 1; on resume the engine offsets its store and
 * part-record writes by the parts already produced, so durable records always
 * carry real part numbers.
 */
function offsetPartStore(inner: PartStore, base: number): PartStore {
    if (base === 0) {
        return inner;
    }
    return {
        stagePart: (partNumber, chunks) => inner.stagePart(base + partNumber, chunks),
        readPart: (partNumber) => inner.readPart(base + partNumber),
        deletePart: (partNumber) => inner.deletePart(base + partNumber),
        listParts: async () =>
            (await inner.listParts())
                .filter((p) => p.partNumber > base)
                .map((p) => ({ partNumber: p.partNumber - base, size: p.size })),
        destroy: () => inner.destroy(),
    };
}

function offsetPartState(inner: EngineStateStore, base: number): EngineStateStore {
    if (base === 0) {
        return inner;
    }
    return {
        putLease: (l) => inner.putLease(l),
        getLease: (fileId) => inner.getLease(fileId),
        putEnvelope: (e) => inner.putEnvelope(e),
        getEnvelope: (fileId) => inner.getEnvelope(fileId),
        // checkpointOf already emits real part numbers — pass through.
        putCheckpoint: (c) => inner.putCheckpoint(c),
        getCheckpoint: (fileId) => inner.getCheckpoint(fileId),
        putPart: (p) => inner.putPart({ ...p, partNumber: base + p.partNumber }),
        putPartAndCheckpoint: (p, c) =>
            inner.putPartAndCheckpoint({ ...p, partNumber: base + p.partNumber }, c),
        getParts: (fileId) => inner.getParts(fileId),
        listLeases: () => inner.listLeases(),
        clearUpload: (fileId) => inner.clearUpload(fileId),
    };
}

/**
 * Ordered cancel teardown [R6]: authenticated server abort (best-effort — the
 * bucket lifecycle rule reaps orphaned parts if it fails), `cancelled` ack,
 * then local part-store and state cleanup.
 */
async function cancelCleanup(job: EngineJob, deps: EngineDeps): Promise<void> {
    try {
        await deps.abortUpload(job.fileId, job.uploadToken);
    } catch {
        // best-effort — cancellation must still complete locally
    }
    deps.onEvent({ type: 'cancelled' });
    try {
        await deps.store.destroy();
    } catch {
        // best-effort — OPFS GC covers leftovers
    }
    try {
        await deps.state.clearUpload(job.fileId);
    } catch {
        // best-effort — lease GC covers leftovers
    }
}

/** Unbounded push queue with pull-based async consumption; null once closed
 * and drained. */
class AsyncQueue<T> {
    private readonly items: T[] = [];
    private readonly waiters: ((item: T | null) => void)[] = [];
    private closed = false;

    push(item: T): void {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter(item);
        } else {
            this.items.push(item);
        }
    }

    close(): void {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
            waiter(null);
        }
    }

    next(): Promise<T | null> {
        const item = this.items.shift();
        if (item !== undefined) {
            return Promise.resolve(item);
        }
        if (this.closed) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }
}

function isRetryableEngineError(error: Error): boolean {
    return error instanceof PartStoreQuotaError || isRetryableError(error);
}

function throwIfCancelled(cancel: AbortSignal): void {
    if (cancel.aborted) {
        throw new Error('Upload cancelled');
    }
}

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}
