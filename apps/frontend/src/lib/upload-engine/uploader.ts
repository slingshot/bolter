/**
 * Pull-based concurrent uploader for the worker upload engine.
 *
 * N workers pull staged parts from a queue and PUT them with the injected
 * `uploadPart` transport. Every attempt re-reads the committed part from the
 * `PartStore`, so retries are byte-identical by construction. Stall detection
 * is wall-clock based [R14]: a coarse poll measures `now()` since the last
 * progress event — a throttled or suspended timer that fires late still sees
 * the true delta, so cadence is never trusted. Retryable failures back off via
 * the injected `retryDelayMs`, and while `isOnline()` reports offline the
 * retry parks on a 1s wall-clock connectivity poll instead of burning
 * attempts on a dead link. The relay flag alone is not trusted [R14]: the
 * worker additionally infers offline from consecutive immediate
 * connection-shaped failures (instant rejection, zero bytes transferred, no
 * HTTP status) — once inferred, retries stop consuming the per-part attempt
 * budget and keep probing at the backoff interval, so a missed `offline`
 * relay can neither park the upload forever nor burn it to a terminal
 * failure during an outage the legacy pipeline would have ridden out. Any
 * transferred byte resets the inference. A 403-style pre-signed-URL expiry
 * triggers one `refreshUrls()` per part. On success the uploaded+ETag record is persisted
 * **before** the staged bytes are deleted [R11], so a crash between the two
 * re-deletes rather than re-uploads; the delete itself is then detached and
 * best-effort, so no worker's turnaround waits on storage. Progress is coalesced to a wall-clock
 * cadence and stamped with the time this uploader observed the bytes, so the
 * consumer times throughput by production rather than by delivery.
 *
 * Worker-safe: no DOM globals — `setTimeout` and `AbortController` exist in
 * dedicated workers (and the timer is injectable for deterministic tests).
 */

import { isRetryableError } from '@/lib/upload-shared';
import type { PartStore } from './part-store';
import type { EngineStateStore } from './state';

/** Result of one part PUT. (Task 9's `EngineDeps['uploadPart']` shape.) */
export interface UploadPartResult {
    etag: string;
}

export interface UploaderOpts {
    urls: string[]; // index 0 = part 1
    maxConcurrent: number;
    store: PartStore;
    state: EngineStateStore;
    fileId: string;
    uploadPart(
        url: string,
        body: Blob,
        hooks: { onProgress(loaded: number): void; signal: AbortSignal },
    ): Promise<UploadPartResult>;
    refreshUrls(): Promise<string[]>;
    now(): number; // wall clock (Date.now)
    isOnline(): boolean; // fed by connectivity relay
    stallMs?: number; // default 60_000 wall-clock without progress
    maxAttemptsPerPart?: number; // default 6
    /** Minimum wall clock between byte-driven progress emissions; default
     * 250ms. Part completions and a part's final byte always emit. */
    progressEmitMs?: number;
    /** Consecutive immediate connection failures that flip the run to
     * inferred-offline probing [R14]; default 3. */
    offlineInferenceThreshold?: number;
    /** A failure faster than this with zero bytes transferred counts as
     * "immediate" for offline inference; default 5_000 wall-clock ms. */
    immediateFailureMs?: number;
    retryDelayMs(attempt: number): number; // from upload-shared (Task 1)
    /** `atMs` is this uploader's own clock reading for `totalBytesSent` —
     * carried to the consumer so a rate is never timed by message delivery. */
    onProgress(totalBytesSent: number, atMs: number): void;
    onRetry(): void;
    signal: AbortSignal;
    /** Injectable timer for deterministic tests; defaults to `setTimeout`. */
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

const DEFAULT_STALL_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_OFFLINE_INFERENCE_THRESHOLD = 3;
const DEFAULT_IMMEDIATE_FAILURE_MS = 5_000;
/** Byte-driven progress cadence. XHR fires ~60 upload progress events per
 * second *per in-flight part*; relaying each one posts hundreds of messages a
 * second at the main thread, which is itself a source of the jank that used to
 * corrupt the reported speed. */
const DEFAULT_PROGRESS_EMIT_MS = 250;
/** Coarse stall-poll interval — checks compute wall-clock deltas, so a poll
 * that fires late (throttling, suspension) still measures correctly. */
const STALL_POLL_MS = 1_000;
const ONLINE_POLL_MS = 1_000;

/** Pre-signed URL expiry surfaces as a 403 from the bucket. */
function isUrlExpiryError(error: Error): boolean {
    const msg = (error.message || '').toLowerCase();
    return msg.includes('http 403') || msg.includes('forbidden');
}

/**
 * Failure shapes only a dead link produces — the request never got an HTTP
 * status ("HTTP 0", generic network errors). A fast 5xx/429 is a *server*
 * answering and must never feed offline inference [R14].
 */
function looksLikeConnectionFailure(error: Error): boolean {
    const msg = (error.message || '').toLowerCase();
    return msg.includes('http 0') || msg.includes('network') || msg.includes('failed to fetch');
}

/**
 * Upload every part the queue yields; resolves to `partNumber → ETag` once the
 * queue returns null and all in-flight parts have finished. Pull-based: the
 * stager feeds the queue as parts commit. Any worker's terminal failure (or
 * the caller's abort signal) aborts every other in-flight attempt and rejects
 * the whole run.
 */
export async function runUploaders(
    partsToUpload: () => Promise<{ partNumber: number; size: number } | null>,
    opts: UploaderOpts,
): Promise<Map<number, string>> {
    const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    const maxAttempts = Math.max(1, opts.maxAttemptsPerPart ?? DEFAULT_MAX_ATTEMPTS);
    const offlineInferenceThreshold = Math.max(
        1,
        opts.offlineInferenceThreshold ?? DEFAULT_OFFLINE_INFERENCE_THRESHOLD,
    );
    const immediateFailureMs = opts.immediateFailureMs ?? DEFAULT_IMMEDIATE_FAILURE_MS;
    const progressEmitMs = Math.max(0, opts.progressEmitMs ?? DEFAULT_PROGRESS_EMIT_MS);
    const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

    // Offline inference [R14]: run-wide because a dead link fails every
    // worker's attempts alike, and any transferred byte anywhere proves the
    // network is alive again.
    let consecutiveImmediateFailures = 0;

    let urls = opts.urls;
    const etags = new Map<number, string>();

    // Run-wide abort: external cancel or another worker's terminal failure.
    // `fatal` keeps the originating error so late-aborted workers rethrow the
    // real cause instead of their own transport-abort noise.
    const run = new AbortController();
    let fatal: Error | undefined;
    const abortError = () => fatal ?? new Error('Upload cancelled');
    const abortRun = (reason?: Error) => {
        if (run.signal.aborted) {
            return;
        }
        fatal = fatal ?? reason;
        run.abort();
    };
    const throwIfAborted = () => {
        if (run.signal.aborted) {
            throw abortError();
        }
    };

    if (opts.signal.aborted) {
        throw abortError();
    }
    const onExternalAbort = () => abortRun();
    opts.signal.addEventListener('abort', onExternalAbort, { once: true });

    /** Rejects when the run aborts — raced against queue pulls so a worker
     * parked on an empty queue still unwinds on cancel. */
    const aborted = new Promise<never>((_resolve, reject) => {
        run.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    aborted.catch(() => undefined); // handled by racers; never unhandled

    const sleep = (ms: number) =>
        new Promise<void>((resolve, reject) => {
            if (run.signal.aborted) {
                reject(abortError());
                return;
            }
            const onAbort = () => reject(abortError());
            run.signal.addEventListener('abort', onAbort, { once: true });
            setTimeoutFn(() => {
                run.signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
        });

    const waitForOnline = async () => {
        while (!opts.isOnline()) {
            throwIfAborted();
            await sleep(ONLINE_POLL_MS);
        }
    };

    // Progress = completed part bytes + the current attempt's transferred
    // bytes. A failed attempt's contribution is dropped (its bytes will be
    // re-sent), so totals stay truthful across retries.
    let completedBytes = 0;
    const inFlight = new Map<number, number>();
    // Byte-driven emissions are coalesced to `progressEmitMs` of wall clock;
    // the state changes a consumer must not miss — a part finishing, its final
    // byte going out, an attempt's bytes being dropped — force an emission
    // regardless of cadence, so nothing sits unreported behind a quiet window.
    let lastEmitAt = Number.NEGATIVE_INFINITY;
    const emitProgress = (force = false) => {
        const at = opts.now();
        if (!force && at - lastEmitAt < progressEmitMs) {
            return;
        }
        lastEmitAt = at;
        let total = completedBytes;
        for (const loaded of inFlight.values()) {
            total += loaded;
        }
        opts.onProgress(total, at);
    };

    /** One attempt: re-read the committed part, PUT it, stall-watch it. */
    const attemptPart = async (partNumber: number, size: number): Promise<UploadPartResult> => {
        const url = urls[partNumber - 1];
        if (!url) {
            throw new Error(`no pre-signed URL for part ${partNumber}`);
        }
        // Byte-identity across retries: every attempt re-reads the store.
        const body = await opts.store.readPart(partNumber);

        const attempt = new AbortController();
        let stallError: Error | undefined;
        const onRunAbort = () => attempt.abort();
        run.signal.addEventListener('abort', onRunAbort, { once: true });

        let lastProgressAt = opts.now();
        let settled = false;
        const checkStall = () => {
            if (settled || attempt.signal.aborted) {
                return;
            }
            if (opts.now() - lastProgressAt > stallMs) {
                stallError = new Error(
                    `Upload stalled: no progress for ${stallMs}ms on part ${partNumber}`,
                );
                attempt.abort();
                return;
            }
            setTimeoutFn(checkStall, STALL_POLL_MS);
        };
        setTimeoutFn(checkStall, STALL_POLL_MS);

        try {
            return await opts.uploadPart(url, body, {
                onProgress: (loaded) => {
                    lastProgressAt = opts.now();
                    consecutiveImmediateFailures = 0; // bytes moved — link is alive
                    inFlight.set(partNumber, loaded);
                    // The part's last byte is reported immediately: the
                    // response can be seconds behind it, and coalescing it
                    // away would leave the bar short for that whole wait.
                    emitProgress(loaded >= size);
                },
                signal: attempt.signal,
            });
        } catch (err) {
            if (stallError) {
                // The transport rejects with its own abort error; the stall is
                // the real (retryable) cause.
                throw stallError;
            }
            throw err;
        } finally {
            settled = true;
            run.signal.removeEventListener('abort', onRunAbort);
        }
    };

    const uploadOnePart = async (partNumber: number, size: number): Promise<void> => {
        let urlRefreshed = false;
        for (let attempt = 0; ; attempt++) {
            throwIfAborted();
            const attemptStart = opts.now();
            try {
                const { etag } = await attemptPart(partNumber, size);
                inFlight.delete(partNumber);
                completedBytes += size;
                emitProgress(true);
                // Durable ordering [R11]: commit the uploaded+ETag record
                // first — a crash between the two re-deletes, never re-uploads.
                await opts.state.putPart({
                    fileId: opts.fileId,
                    partNumber,
                    size,
                    staged: true,
                    uploaded: true,
                    etag,
                });
                etags.set(partNumber, etag);
                // With that record durable the staged bytes are dead weight,
                // so releasing them is detached: awaiting an OPFS delete (a
                // handful of round trips) before pulling the next part put
                // storage latency directly into this worker's turnaround. A
                // lost delete costs space, never progress — completion and
                // cancel both `destroy()` the whole directory, startup GC
                // reaps orphaned ones, and reconciliation reads an
                // uploaded+ETag record as intact whether or not its file
                // survived.
                opts.store.deletePart(partNumber).catch((err: unknown) => {
                    console.debug(`[Engine] could not release staged part ${partNumber}:`, err);
                });
                return;
            } catch (err) {
                inFlight.delete(partNumber);
                emitProgress(true);
                // A run-level abort wins over whatever this attempt threw.
                throwIfAborted();
                const error = err instanceof Error ? err : new Error(String(err));
                if (isUrlExpiryError(error) && !urlRefreshed) {
                    // Pre-signed URLs expired — refresh once per part, retry
                    // immediately (no backoff: this is not a transport fault).
                    urlRefreshed = true;
                    urls = await opts.refreshUrls();
                    opts.onRetry();
                    continue;
                }
                if (!isRetryableError(error)) {
                    throw error;
                }
                // Offline inference [R14]: an instant connection-shaped
                // failure with no bytes transferred looks like a dead link
                // the relay never told us about.
                if (
                    looksLikeConnectionFailure(error) &&
                    opts.now() - attemptStart < immediateFailureMs
                ) {
                    consecutiveImmediateFailures += 1;
                } else {
                    consecutiveImmediateFailures = 0;
                }
                const inferredOffline = consecutiveImmediateFailures >= offlineInferenceThreshold;
                if (!inferredOffline && attempt + 1 >= maxAttempts) {
                    throw error;
                }
                opts.onRetry();
                await sleep(opts.retryDelayMs(attempt));
                await waitForOnline();
                if (inferredOffline) {
                    // Parked probing: keep retrying at the backoff interval
                    // without burning the attempt budget — the run must ride
                    // out an outage, not die 60s into it. Recovery (any byte
                    // of progress) resets the inference and the budget rules.
                    attempt -= 1;
                }
            }
        }
    };

    const workerLoop = async (): Promise<void> => {
        while (true) {
            throwIfAborted();
            const next = await Promise.race([partsToUpload(), aborted]);
            if (next === null) {
                return;
            }
            await uploadOnePart(next.partNumber, next.size);
        }
    };

    try {
        const workers = Array.from({ length: Math.max(1, opts.maxConcurrent) }, () =>
            workerLoop().catch((err: unknown) => {
                const error = err instanceof Error ? err : new Error(String(err));
                abortRun(error);
                throw error;
            }),
        );
        await Promise.all(workers);
        return etags;
    } finally {
        opts.signal.removeEventListener('abort', onExternalAbort);
    }
}
