import { reaperLogger as logger } from './logger';
import { redis } from './storage/redis';

/**
 * Object reaper.
 *
 * Redis metadata expires on its own TTL, but nothing in the app ever deleted the
 * underlying S3/R2 object or aborted a multipart upload that was never
 * completed — so an "expired" file kept living in the bucket (unbounded cost,
 * and the "expired links disappear" promise silently broken for any operator
 * without a bucket lifecycle rule; even with one, an age/prefix rule cannot
 * honor variable per-file TTLs).
 *
 * Every object that gets created is registered here with the wall-clock time it
 * becomes garbage, plus the provider it lives in and (if any) its multipart
 * uploadId. A periodic sweep deletes anything past its deadline whose metadata
 * key is genuinely gone. The record carries `providerId` because after the
 * metadata key expires there is no other way to know which bucket holds the
 * object — resolving "the active provider" at reap time could delete from, or
 * leak into, the wrong bucket.
 */

/** Redis hash: file/test id -> serialized ReapRecord. Deliberately has no TTL. */
export const REAP_KEY = 'bolter:reap';

export interface ReapRecord {
    /**
     * 'file' records are gated on the metadata key being gone; 'speedtest' are not.
     *
     * Nothing writes 'speedtest' any more — `POST /upload/speedtest` was deleted
     * along with the preflight probe. The kind is retained deliberately: records
     * live for 15 minutes, so some were still in Redis across that deploy, and
     * they are not gated on a metadata key they never had. Safe to drop once no
     * pre-deletion record can remain.
     */
    kind: 'file' | 'speedtest';
    id: string;
    providerId?: string;
    uploadId?: string;
    /** epoch milliseconds */
    expiresAt: number;
}

const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
/** Bound the work of a single sweep so a large backlog can't stall the process */
const MAX_PER_SWEEP = 200;
/** A record whose key has no TTL is retried a day later rather than deleted */
const NO_TTL_RETRY_MS = 86_400_000;

/** Register (or refresh) an object for reaping. Never throws — bookkeeping must not fail an upload. */
export async function scheduleObjectReap(record: ReapRecord): Promise<void> {
    try {
        await redis.hSet(REAP_KEY, record.id, JSON.stringify(record));
    } catch (e) {
        logger.warn({ id: record.id, error: e }, 'Failed to schedule object reap');
    }
}

/** Drop a reap record — the object was already cleaned up through a normal path. */
export async function unscheduleObjectReap(id: string): Promise<void> {
    try {
        await redis.hDel(REAP_KEY, id);
    } catch (e) {
        logger.warn({ id, error: e }, 'Failed to unschedule object reap');
    }
}

/** Read one reap record, e.g. to recover the provider an id was pinned to. */
export async function getReapRecord(id: string): Promise<ReapRecord | null> {
    try {
        const raw = await redis.hGet(REAP_KEY, id);
        if (!raw) {
            return null;
        }
        return parseReapRecord(id, raw);
    } catch (e) {
        logger.warn({ id, error: e }, 'Failed to read reap record');
        return null;
    }
}

function parseReapRecord(id: string, raw: string): ReapRecord | null {
    try {
        const parsed = JSON.parse(raw) as Partial<ReapRecord>;
        if (typeof parsed?.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) {
            return null;
        }
        return {
            kind: parsed.kind === 'speedtest' ? 'speedtest' : 'file',
            id: typeof parsed.id === 'string' ? parsed.id : id,
            providerId: typeof parsed.providerId === 'string' ? parsed.providerId : undefined,
            uploadId: typeof parsed.uploadId === 'string' ? parsed.uploadId : undefined,
            expiresAt: parsed.expiresAt,
        };
    } catch {
        return null;
    }
}

/**
 * Split a raw reap hash into records that are due now and entries that can never
 * be parsed (which are dropped so they don't accumulate forever).
 */
export function selectDueRecords(
    raw: Record<string, string> | null,
    now: number,
    limit: number = MAX_PER_SWEEP,
): { due: ReapRecord[]; malformed: string[] } {
    const due: ReapRecord[] = [];
    const malformed: string[] = [];
    if (!raw) {
        return { due, malformed };
    }

    for (const [id, value] of Object.entries(raw)) {
        const record = parseReapRecord(id, value);
        if (!record) {
            malformed.push(id);
            continue;
        }
        if (record.expiresAt <= now) {
            due.push(record);
        }
    }

    // Oldest deadline first, so a backlog drains in the order it accrued
    due.sort((a, b) => a.expiresAt - b.expiresAt);
    return { due: due.slice(0, limit), malformed };
}

/**
 * Resolve the provider a record was pinned to. Imported lazily so the reap
 * bookkeeping helpers (used by the upload route) don't drag the whole provider
 * registry / S3 client graph into every importer.
 */
async function resolveProvider(providerId?: string) {
    const { providerRegistry } = await import('./storage/provider-registry');
    if (providerId) {
        try {
            return await providerRegistry.getOrLoadProvider(providerId);
        } catch (e) {
            logger.warn(
                { providerId, error: e },
                'Reap record references an unknown provider — falling back to default',
            );
        }
    }
    return providerRegistry.getDefaultProvider();
}

export interface SweepResult {
    reaped: number;
    rescheduled: number;
    malformed: number;
    failed: number;
}

/** One pass: delete expired objects, abort their stale multipart uploads. */
export async function runReaperSweep(now: number = Date.now()): Promise<SweepResult> {
    const result: SweepResult = { reaped: 0, rescheduled: 0, malformed: 0, failed: 0 };

    let raw: Record<string, string> | null;
    try {
        raw = await redis.hGetAll(REAP_KEY);
    } catch (e) {
        logger.error({ error: e }, 'Reaper sweep failed to read schedule');
        return result;
    }

    const { due, malformed } = selectDueRecords(raw, now);

    for (const id of malformed) {
        await unscheduleObjectReap(id);
        result.malformed++;
    }

    for (const record of due) {
        try {
            if (record.kind === 'file') {
                // The metadata key still being present means the file is alive —
                // an owner may have extended its TTL via /params. Never delete a
                // live object; re-arm from the authoritative TTL instead.
                const alive = await redis.exists(record.id);
                if (alive) {
                    const ttl = await redis.ttl(record.id);
                    const nextExpiry = ttl > 0 ? now + ttl * 1000 : now + NO_TTL_RETRY_MS;
                    await scheduleObjectReap({ ...record, expiresAt: nextExpiry });
                    result.rescheduled++;
                    continue;
                }
            }

            const provider = await resolveProvider(record.providerId);

            if (record.uploadId) {
                // Aborting an already-completed (or already-aborted) upload is a
                // no-op error we don't care about
                await provider.abortMultipartUpload(record.id, record.uploadId).catch(() => {
                    /* NoSuchUpload — nothing left to abort */
                });
            }

            await provider.del(record.id);
            await unscheduleObjectReap(record.id);
            result.reaped++;

            logger.info(
                { id: record.id, kind: record.kind, providerId: record.providerId },
                'Reaped expired object',
            );
        } catch (e) {
            // Leave the record in place so the next sweep retries it
            result.failed++;
            logger.warn({ id: record.id, error: e }, 'Failed to reap expired object');
        }
    }

    if (result.reaped || result.malformed || result.failed) {
        logger.info(result, 'Reaper sweep complete');
    }

    return result;
}

export function reaperIntervalSeconds(): number {
    const parsed = parseInt(process.env.REAPER_INTERVAL_SECONDS || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_INTERVAL_SECONDS;
    }
    return Math.max(parsed, MIN_INTERVAL_SECONDS);
}

/** Start the periodic sweep. Returns a stop handle (used by tests / shutdown). */
export function startReaper(): { stop: () => void } {
    if (process.env.REAPER_ENABLED === 'false') {
        logger.warn(
            'Object reaper disabled — expired objects will only be removed by bucket lifecycle rules',
        );
        return { stop: () => undefined };
    }

    const intervalSeconds = reaperIntervalSeconds();
    const timer = setInterval(() => {
        runReaperSweep().catch((e) => {
            logger.error({ error: e }, 'Reaper sweep threw');
        });
    }, intervalSeconds * 1000);

    // Don't hold the process open for the timer
    (timer as unknown as { unref?: () => void }).unref?.();

    logger.info({ intervalSeconds }, 'Object reaper started');
    return { stop: () => clearInterval(timer) };
}
