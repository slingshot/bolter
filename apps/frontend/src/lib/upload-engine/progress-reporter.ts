/**
 * Adapts the engine's cumulative bytes-sent events to the legacy
 * `UploadProgress` shape (smoothed speed, ETA, connection quality, offline
 * awareness), with a 1s poll so offline/stalled states surface even when no
 * bytes are flowing — mirroring the legacy pipeline's reporting.
 *
 * Speed is folded over **wall-clock windows**, never per message. The engine
 * posts progress from a worker, so delivery is at the mercy of the main
 * thread's event loop: a janky frame queues messages and drains them a
 * millisecond apart. Dividing a real byte delta by that phantom gap fabricates
 * throughput (100+ MB/s on a 10 MB/s link) and with it a nonsense ETA. So one
 * fold per >= 1s of elapsed wall clock, over every byte accumulated across
 * that whole window, preferring the producer's own timestamp (`atMs`, stamped
 * in the worker) so delivery batching structurally cannot show up as speed.
 *
 * Two counters, deliberately: `displayed` is a high-water mark that feeds the
 * bar, and `windowBytes` is the rate origin. They diverge in the two cases
 * that used to produce phantom numbers — a resume's already-uploaded baseline
 * (real progress, but not bytes this session moved) and a part retry dropping
 * its in-flight bytes (a counter regression, not a negative rate).
 *
 * Worker-safe: no DOM globals (`UploadProgress` is a type-only import), and
 * clock, timer and connectivity are injectable for deterministic tests.
 */

import type { UploadProgress } from '@/lib/api';

/** Minimum wall clock per EMA fold — the legacy pipeline's 1s window. */
const SPEED_WINDOW_MS = 1_000;
/** EMA weights, unchanged from the legacy pipeline's ~1s time constant. */
const EMA_PRIOR_WEIGHT = 0.7;
const EMA_SAMPLE_WEIGHT = 0.3;
/** Re-render cadence, so offline/stalled surface without byte flow. */
const EMIT_POLL_MS = 1_000;
/** No forward progress for this long reads as stalled. */
const STALL_AFTER_MS = 10_000;
const SLOW_BYTES_PER_SECOND = 1 * 1024 * 1024;
const FAIR_BYTES_PER_SECOND = 10 * 1024 * 1024;

export interface EngineProgressReporter {
    /** Cumulative bytes sent, the job's total, and the worker's own clock
     * reading when it observed them (absent for pre-`atMs` messages). */
    onProgress(sent: number, total: number, atMs?: number): void;
    onRetry(): void;
    stop(): void;
}

export interface EngineProgressReporterDeps {
    now(): number;
    isOnline(): boolean;
    setIntervalFn(fn: () => void, ms: number): unknown;
    clearIntervalFn(handle: unknown): void;
}

export function createEngineProgressReporter(
    totalSize: number,
    onProgress?: (progress: UploadProgress) => void,
    deps: Partial<EngineProgressReporterDeps> = {},
): EngineProgressReporter {
    const now = deps.now ?? (() => Date.now());
    const isOnline =
        deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    const clearIntervalFn =
        deps.clearIntervalFn ??
        ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

    let retryCount = 0;
    let smoothedSpeed = 0;
    // Explicit rather than `smoothedSpeed === 0`: a stalled window folds a
    // legitimate zero, and treating that as "unseeded" would adopt the next
    // sample unsmoothed — the spike this reporter exists to prevent.
    let hasSpeedSample = false;
    let latestTotal = totalSize;

    let displayed = 0; // high-water mark: a bar walking backwards reads as data loss
    let lastSent = 0;
    let started = false;
    let windowBytes = 0; // rate origin: bytes at the last fold (or re-baseline)
    let windowStart = now();
    let lastForwardProgress = now();

    const emit = () => {
        const at = now();
        const offline = !isOnline();
        let connectionQuality: UploadProgress['connectionQuality'];
        if (offline) {
            connectionQuality = 'offline';
        } else if (smoothedSpeed === 0 || at - lastForwardProgress > STALL_AFTER_MS) {
            connectionQuality = 'stalled';
        } else if (smoothedSpeed < SLOW_BYTES_PER_SECOND) {
            connectionQuality = 'slow';
        } else if (smoothedSpeed < FAIR_BYTES_PER_SECOND) {
            connectionQuality = 'fair';
        } else {
            connectionQuality = 'good';
        }
        const loaded = Math.min(displayed, latestTotal);
        onProgress?.({
            loaded,
            total: latestTotal,
            percentage: latestTotal > 0 ? Math.min((displayed / latestTotal) * 100, 100) : 0,
            speed: smoothedSpeed,
            remainingTime:
                smoothedSpeed > 0 ? Math.max(0, latestTotal - loaded) / smoothedSpeed : 0,
            retryCount,
            isOffline: offline,
            connectionQuality,
        });
    };

    const pollHandle = setIntervalFn(emit, EMIT_POLL_MS);

    return {
        onProgress(sent: number, total: number, atMs?: number) {
            // The producer's timestamp is the honest one; both clocks are
            // `Date.now()` on the same machine, so they are directly comparable.
            const at = atMs ?? now();
            if (total > 0) {
                latestTotal = total;
            }
            if (sent > displayed) {
                displayed = sent;
            }

            if (!started) {
                // Speed origin. On resume the first message carries every byte
                // a previous session uploaded; folding it would report the
                // whole baseline as this second's throughput ("0s remaining"
                // on a multi-GB upload).
                started = true;
                lastSent = sent;
                windowBytes = sent;
                windowStart = at;
                lastForwardProgress = at;
                emit();
                return;
            }

            if (sent > lastSent) {
                lastForwardProgress = at;
            }
            lastSent = sent;

            if (sent < windowBytes || at < windowStart) {
                // A retry dropped this attempt's in-flight bytes (or a clock
                // went backwards). Restart the window at the regressed count:
                // folding now would measure the drop, not the link.
                windowBytes = sent;
                windowStart = at;
            } else if (at - windowStart >= SPEED_WINDOW_MS) {
                const instant = (sent - windowBytes) / ((at - windowStart) / 1000);
                smoothedSpeed = hasSpeedSample
                    ? smoothedSpeed * EMA_PRIOR_WEIGHT + instant * EMA_SAMPLE_WEIGHT
                    : instant;
                hasSpeedSample = true;
                windowBytes = sent;
                windowStart = at;
            }
            // Anything short of a fold leaves the window open — its bytes stay
            // attributed to it rather than being silently dropped from the rate.
            emit();
        },
        onRetry() {
            retryCount++;
            emit();
        },
        stop() {
            clearIntervalFn(pollHandle);
        },
    };
}
