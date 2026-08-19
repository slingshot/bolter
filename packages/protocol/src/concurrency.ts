/**
 * AIMD concurrency control for Bolter upload clients.
 *
 * Replaces the preflight speed test's role as the adaptive element: instead of
 * spending up to 500MB measuring the link before uploading, the pool observes
 * the upload it is already doing. Additive increase while saturated,
 * multiplicative decrease on server pushback.
 *
 * Growth is gated on *saturation and absence of pushback*, never on a
 * throughput derivative — competing traffic and wifi variance make that the
 * noisiest available signal, and it buys nothing the saturation check does not.
 *
 * Wall-clock only [R14]: every interval decision compares `nowMs` deltas, so a
 * tick throttled or suspended by the browser still measures one elapsed window
 * rather than none or many.
 *
 * Pure state machine — no timers, no I/O, no host globals. Runs unchanged in
 * the browser, a Web Worker and a compiled binary.
 */

export interface ConcurrencyControllerOpts {
    initial: number;
    min: number;
    max: number;
    /** Wall-clock ms between growth probes; default 10s. */
    probeIntervalMs?: number;
    /** Wall-clock ms after pushback during which growth is suppressed; default 60s. */
    cooldownMs?: number;
}

export interface ConcurrencyController {
    target(): number;
    /** Highest target reached this run — telemetry only. */
    peak(): number;
    /** Pushback responses seen this run — telemetry only. */
    pushbacks(): number;
    /** Server said slow down (429/503): halve now, suppress growth for the cooldown. */
    onPushback(nowMs: number): void;
    /** A worker waited on an empty queue: staging is the bottleneck, not the pool. */
    onIdle(): void;
    /** Wall-clock probe. Returns the (possibly grown) target. */
    tick(nowMs: number): number;
}

const DEFAULT_PROBE_INTERVAL_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Only a server *answering* with "slow down" counts.
 *
 * Deliberately excludes: 403 (pre-signed URL expiry — one refresh, not
 * congestion), HTTP 0 / network errors (feed offline inference, which has its
 * own park-and-poll path), and 5xx other than 503 (retryable faults). Shrinking
 * on those would confuse an outage for congestion and starve the recovery.
 */
export function isPushbackError(error: Error): boolean {
    const msg = (error.message || '').toLowerCase();
    return msg.includes('http 429') || msg.includes('http 503');
}

export function createConcurrencyController(
    opts: ConcurrencyControllerOpts,
): ConcurrencyController {
    const min = Math.max(1, Math.floor(opts.min));
    const max = Math.max(min, Math.floor(opts.max));
    const probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    let target = Math.min(max, Math.max(min, Math.floor(opts.initial)));
    let peak = target;
    let pushbacks = 0;
    let windowStartedAt: number | undefined;
    let growthSuppressedUntil = Number.NEGATIVE_INFINITY;
    let idledThisWindow = false;

    return {
        target: () => target,
        peak: () => peak,
        pushbacks: () => pushbacks,

        onPushback(nowMs: number) {
            pushbacks += 1;
            target = Math.max(min, Math.floor(target / 2));
            growthSuppressedUntil = nowMs + cooldownMs;
            // The window's saturation reading described a pool that no longer
            // exists; start the next one clean.
            idledThisWindow = false;
            windowStartedAt = nowMs;
        },

        onIdle() {
            idledThisWindow = true;
        },

        tick(nowMs: number) {
            // The first tick establishes the window origin. Growing on it would
            // treat "the run just started" as "a full quiet window elapsed".
            if (windowStartedAt === undefined) {
                windowStartedAt = nowMs;
                return target;
            }
            if (nowMs - windowStartedAt < probeIntervalMs) {
                return target;
            }
            windowStartedAt = nowMs;
            const saturated = !idledThisWindow;
            idledThisWindow = false;

            if (nowMs < growthSuppressedUntil || !saturated || target >= max) {
                return target;
            }
            target += 1;
            peak = Math.max(peak, target);
            return target;
        },
    };
}
