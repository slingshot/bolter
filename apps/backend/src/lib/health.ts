/**
 * Health probing for the unauthenticated `/health`, `/health/ready` and
 * `/__heartbeat__` endpoints (audit finding #29).
 *
 * The naive implementation called `storage.ping()`, which fans an untimed
 * `HeadBucket` out to EVERY registered provider on every request. That has two
 * distinct failure modes:
 *
 *  1. **Amplification** — an unauthenticated request flood turns into N× S3 API
 *     calls. Fixed by memoising the result for `healthCacheTtlSeconds`.
 *  2. **Head-of-line stalling** — the S3 client sets no request timeout, so a
 *     single decommissioned, black-holing provider makes every probe hang for
 *     the socket timeout, flapping readiness and pulling a perfectly healthy
 *     replica out of rotation. Caching alone does not fix this; it makes it
 *     worse, because de-duplicated probes all park on the same hung call.
 *
 * So the probe is *bounded*, not merely cached:
 *
 *  - only the ACTIVE provider is checked (readiness never depended on the
 *    others — `storage.ping()` discarded every non-active result anyway);
 *  - each dependency gets its own `healthProbeTimeoutMs` budget and degrades to
 *    `false` rather than hanging;
 *  - while a refresh is in flight, other callers are served the last known
 *    result instead of queueing behind it.
 */
import { config } from '../config';
import { logger } from '../logger';
import { providerRegistry } from '../storage/provider-registry';
import { redis } from '../storage/redis';

export interface HealthResult {
    redis: boolean;
    /** Health of the ACTIVE storage provider only. */
    s3: boolean;
    /** Provider id the `s3` field refers to. */
    provider: string;
}

export interface HealthTiming {
    /** How long a probe result is reused before a refresh is triggered. */
    cacheTtlMs: number;
    /** Per-dependency budget for one probe. */
    probeTimeoutMs: number;
}

function timingFromConfig(): HealthTiming {
    return {
        cacheTtlMs: config.healthCacheTtlSeconds * 1000,
        probeTimeoutMs: config.healthProbeTimeoutMs,
    };
}

let timing: HealthTiming = timingFromConfig();
let cached: { value: HealthResult; at: number } | null = null;
let inflight: Promise<HealthResult> | null = null;

/** Test seam — drops the memoised result and restores configured timing. */
export function resetHealthCache(): void {
    cached = null;
    inflight = null;
    timing = timingFromConfig();
}

/** Test seam — shortens the cache/timeout windows so tests need not wait. */
export function setHealthTiming(next: Partial<HealthTiming>): void {
    timing = { ...timing, ...next };
}

export function getHealthTiming(): HealthTiming {
    return { ...timing };
}

/**
 * Resolve `fallback` if `promise` has not settled within `ms`.
 *
 * Deliberately does not cancel the underlying work — the AWS SDK request will
 * finish or fail on its own; we just refuse to wait for it.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, probe: string): Promise<T> {
    return new Promise<T>((resolve) => {
        let settled = false;
        const done = (value: T) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        const timer = setTimeout(() => {
            logger.warn({ probe, timeoutMs: ms }, 'Health probe timed out');
            done(fallback);
        }, ms);
        // Never hold the process open just for a health probe timer.
        timer.unref?.();

        promise.then(done, (error) => {
            logger.warn({ probe, error }, 'Health probe failed');
            done(fallback);
        });
    });
}

async function probeDependencies(): Promise<HealthResult> {
    // Resolving the active id can throw if the registry never initialised.
    let provider: string;
    try {
        provider = providerRegistry.getActiveProviderId();
    } catch (error) {
        logger.warn({ error }, 'Could not resolve active storage provider for health probe');
        return {
            redis: await withTimeout(redis.ping(), timing.probeTimeoutMs, false, 'redis'),
            s3: false,
            provider: 'unknown',
        };
    }

    const [redisOk, s3Ok] = await Promise.all([
        withTimeout(redis.ping(), timing.probeTimeoutMs, false, 'redis'),
        withTimeout(
            providerRegistry.healthCheckProvider(provider).then((result) => result.healthy),
            timing.probeTimeoutMs,
            false,
            'storage',
        ),
    ]);

    return { redis: redisOk, s3: s3Ok, provider };
}

/**
 * Current health, memoised for `cacheTtlMs`.
 *
 * The caller that finds the cache stale triggers (and awaits) the refresh —
 * bounded by `probeTimeoutMs`, so it always answers promptly. Anyone arriving
 * while that refresh is in flight is handed the previous result immediately,
 * so a slow dependency can never park a pile of concurrent probes.
 */
export function getHealth(): Promise<HealthResult> {
    if (cached && Date.now() - cached.at < timing.cacheTtlMs) {
        return Promise.resolve(cached.value);
    }

    const alreadyRefreshing = inflight !== null;
    if (!inflight) {
        inflight = probeDependencies()
            .catch((error): HealthResult => {
                logger.error({ error }, 'Health probe threw unexpectedly');
                return { redis: false, s3: false, provider: 'unknown' };
            })
            .then((value) => {
                cached = { value, at: Date.now() };
                return value;
            })
            .finally(() => {
                inflight = null;
            });
    }

    if (alreadyRefreshing && cached) {
        return Promise.resolve(cached.value);
    }
    return inflight;
}
