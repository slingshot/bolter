import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { UPLOAD_LIMITS } from '@bolter/shared';
import { Elysia, t } from 'elysia';
import { config, deriveBaseUrl } from '../config';
import { captureError } from '../lib/sentry';
import { uploadLogger as logger } from '../logger';
import { getReapRecord, scheduleObjectReap, unscheduleObjectReap } from '../reaper';
import { type CompletedPart, storage } from '../storage';
import { providerRegistry } from '../storage/provider-registry';

const MULTIPART_THRESHOLD = UPLOAD_LIMITS.MULTIPART_THRESHOLD;
const DEFAULT_PART_SIZE = UPLOAD_LIMITS.DEFAULT_PART_SIZE;
const MAX_PARTS = UPLOAD_LIMITS.MAX_PARTS;
const MAX_PART_SIZE = UPLOAD_LIMITS.MAX_PART_SIZE;
const MIN_PART_SIZE = UPLOAD_LIMITS.MIN_PART_SIZE;

/**
 * Bound on trailing-part correction passes. `partSize` only grows across
 * iterations, so `numParts` is monotonically non-increasing and the loop
 * converges — a full sweep of every 1 MB from the multipart threshold to 2 GB
 * and every 1 GB to 1 TB needs at most 3. This exists so a future change to the
 * sizing constants surfaces as a loud failure rather than a hang.
 */
const MAX_TRAILING_PART_PASSES = 64;

interface PartInfo {
    partNumber: number;
    url: string;
    minSize: number;
    maxSize: number;
}

export function calculateOptimalPartSize(
    fileSize: number,
    preferredPartSize?: number,
): { partSize: number; numParts: number } {
    let partSize = DEFAULT_PART_SIZE;

    // Use client-preferred part size if provided and within valid bounds
    if (preferredPartSize) {
        if (preferredPartSize >= MIN_PART_SIZE && preferredPartSize <= MAX_PART_SIZE) {
            partSize = preferredPartSize;
        }
    }

    let numParts = Math.ceil(fileSize / partSize);

    if (numParts > MAX_PARTS) {
        partSize = Math.ceil(fileSize / MAX_PARTS);

        if (partSize > MAX_PART_SIZE) {
            throw new Error('File too large: would require parts larger than 5GB limit');
        }

        partSize = Math.ceil(partSize / (1024 * 1024)) * (1024 * 1024);
        numParts = Math.ceil(fileSize / partSize);
    }

    // Ensure the last part won't be smaller than MIN_PART_SIZE (5MiB).
    // R2 rejects a sub-5MiB non-trailing part as EntityTooSmall *after* the
    // client has transferred every byte, so this must hold on every input.
    //
    // This is a loop, not a single pass. The recomputed, MiB-aligned partSize
    // can itself leave a trailing part under the minimum: 529,000,001 bytes on
    // 25MB parts and 616GB on 50MB parts both allocated illegally under the
    // one-pass version. `numParts = ceil(fileSize / partSize)` guarantees the
    // trailing part is > 0 on entry, so only the lower bound needs testing.
    let trailingPasses = 0;
    while (numParts > 1) {
        const lastPartSize = fileSize - (numParts - 1) * partSize;
        if (lastPartSize >= MIN_PART_SIZE) {
            break;
        }
        if (++trailingPasses > MAX_TRAILING_PART_PASSES) {
            throw new Error(
                `Part sizing failed to converge: fileSize=${fileSize} partSize=${partSize} numParts=${numParts}`,
            );
        }
        numParts = numParts - 1;
        partSize = Math.ceil(fileSize / numParts);
        // Align to MB boundary
        partSize = Math.ceil(partSize / (1024 * 1024)) * (1024 * 1024);
        numParts = Math.ceil(fileSize / partSize);
    }

    return { partSize, numParts };
}

// Pre-signed URL expiration: 7 days (max allowed by S3/R2)
const URL_EXPIRATION_SECONDS = 7 * 24 * 60 * 60; // 604800

/**
 * Clamp the client-declared download limit into a stored, enforceable integer.
 *
 * `config.maxDownloads` was advertised via `GET /config` but never enforced, so a
 * modified client could store `dlimit: 1e9` (making the `dl >= dlimit` gate
 * unreachable — unlimited egress) or a float like `1e21`, which round-trips
 * through Redis as `'1e+21'` and reads back via `parseInt` as `1`, turning the
 * file into an accidental single-use self-destruct.
 */
export function clampDownloadLimit(requested?: number): number {
    const max = Math.max(Math.trunc(config.maxDownloads) || 1, 1);
    const fallback = Math.min(Math.max(Math.trunc(config.defaultDownloads) || 1, 1), max);

    if (requested === undefined || requested === null || !Number.isFinite(requested)) {
        return fallback;
    }
    return Math.min(Math.max(Math.trunc(requested), 1), max);
}

/**
 * Number of files declared in an unencrypted metadata blob, or `null` when the
 * count is not inspectable (audit #5, `MAX_FILES_PER_ARCHIVE`).
 *
 * Archives are assembled client-side, so the file count only ever reaches the
 * server inside the metadata blob. For unencrypted shares that blob is
 * base64-encoded UTF-8 JSON carrying a `files[]` array — the same list the zip
 * entry names come from — so it can be counted. Encrypted metadata is E2E
 * ciphertext and always yields `null`: counting it would require breaking the
 * encryption or trusting a separate client-asserted field, neither of which is
 * worth doing.
 */
export function countDeclaredFiles(metadataB64: string): number | null {
    try {
        const json = Buffer.from(metadataB64, 'base64').toString('utf8');
        const files = (JSON.parse(json) as { files?: unknown })?.files;
        return Array.isArray(files) ? files.length : null;
    } catch {
        return null;
    }
}

/**
 * Clamp the client-declared expiry into a value that is safe to hand to
 * `EXPIRE`. A negative `timeLimit` reached `redis.expire(id, -1)`, which DELETES
 * the key — after which the finalization writes resurrected a TTL-less,
 * ownerless hash plus an object that never time-expires.
 */
export function clampExpireSeconds(requested?: number): number {
    const max = Math.max(Math.trunc(config.maxExpireSeconds) || 1, 1);
    const fallback = Math.min(Math.max(Math.trunc(config.defaultExpireSeconds) || 1, 1), max);

    if (requested === undefined || requested === null || !Number.isFinite(requested)) {
        return fallback;
    }
    const truncated = Math.trunc(requested);
    if (truncated < 1) {
        return fallback;
    }
    return Math.min(truncated, max);
}

// --- Upload-owner token (#52) ---------------------------------------------
// `/upload/abort` and `/upload/multipart/:id/resume` were gated only by the S3
// uploadId. If that opaque value leaks (logs, MITM), a third party could abort a
// victim's in-flight upload or mint fresh pre-signed PUT URLs for its unfinished
// parts and inject bytes before completion. Bind both routes to a secret handed
// only to the uploader, stored as a hash (mirroring the `auth` field guard).

function hashUploadToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export function verifyUploadToken(provided: unknown, storedHash: string): boolean {
    if (typeof provided !== 'string' || provided.length === 0) {
        return false;
    }
    const providedDigest = Buffer.from(hashUploadToken(provided), 'hex');
    const storedDigest = Buffer.from(storedHash, 'hex');
    if (providedDigest.length !== storedDigest.length) {
        return false;
    }
    return timingSafeEqual(providedDigest, storedDigest);
}

/**
 * Whether a stored upload token is *required* on abort/resume, or only verified
 * and reported.
 *
 * The token is minted and stored unconditionally, but rejecting requests that
 * lack it is opt-in for one release. The shipped client does not send
 * `uploadToken` yet, and rejecting it outright regresses two documented
 * behaviors for every upload created by a build that stores the hash:
 *
 *  - cancel: `abortMultipartUpload` does not check `response.ok`, so a 401 is
 *    swallowed and reported as a successful cancel while the S3 multipart, the
 *    metadata, and the provider file counter are all left behind;
 *  - resume: any non-OK response makes the client `deleteUploadState()` and
 *    throw "Upload session expired", destroying the IndexedDB resume state and
 *    orphaning the multipart — resumability stops working entirely.
 *
 * So until the client sends the token, an unverified abort/resume is logged and
 * allowed. Set `UPLOAD_TOKEN_ENFORCED=true` (after the client change ships) to
 * turn the same check into a 401. Read per-request so the flag can be flipped
 * without a code change.
 */
export function uploadTokenEnforced(): boolean {
    return process.env.UPLOAD_TOKEN_ENFORCED === 'true';
}

/**
 * Gate a mutation of an in-flight upload (abort / resume) on the upload token.
 *
 * Returns true when the request may proceed. Uploads created before the
 * `uploadAuth` field existed have no stored hash and are always allowed, so
 * in-flight uploads survive the deploy that introduces the token.
 */
async function authorizeUploadMutation(
    id: string,
    provided: unknown,
    route: 'abort' | 'resume',
    requestId: string,
): Promise<boolean> {
    const storedTokenHash = await storage.getField(id, 'uploadAuth');
    if (!storedTokenHash) {
        return true;
    }
    if (verifyUploadToken(provided, storedTokenHash)) {
        return true;
    }

    // Never log the token itself — only whether one was supplied at all
    const tokenPresent = typeof provided === 'string' && provided.length > 0;
    if (!uploadTokenEnforced()) {
        logger.warn(
            { requestId, id, route, tokenPresent },
            'Unauthorized upload mutation allowed — set UPLOAD_TOKEN_ENFORCED=true to reject',
        );
        return true;
    }

    logger.warn({ requestId, id, route, tokenPresent }, 'Rejected — invalid upload token');
    return false;
}

// --- Speed-test rate limiting (#11) ---------------------------------------
// `POST /upload/speedtest` is unauthenticated and each call mints 5 pre-signed
// UploadPart URLs with no size constraint — an unbounded, repeatable write
// amplification into billable incomplete-multipart storage.

const SPEEDTEST_PREFIX = '__speedtest__';
const SPEEDTEST_RATE_LIMIT = 5;
const SPEEDTEST_RATE_WINDOW_MS = 5 * 60 * 1000;
// A speed test that is never cleaned up by the client is swept by the reaper
const SPEEDTEST_REAP_AFTER_MS = 15 * 60 * 1000;

export class FixedWindowRateLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
    ) {}

    take(key: string, now: number = Date.now()): boolean {
        const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (recent.length >= this.limit) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(now);
        this.hits.set(key, recent);

        // Bound memory — drop buckets whose entries have all aged out
        if (this.hits.size > 1000) {
            for (const [k, times] of this.hits) {
                if (times.every((t) => now - t >= this.windowMs)) {
                    this.hits.delete(k);
                }
            }
        }
        return true;
    }

    reset(): void {
        this.hits.clear();
    }
}

export const speedTestRateLimiter = new FixedWindowRateLimiter(
    SPEEDTEST_RATE_LIMIT,
    SPEEDTEST_RATE_WINDOW_MS,
);

/**
 * Authoritative remaining lifetime of a file, read from the Redis TTL.
 *
 * The metadata TTL starts at `/upload/url` and is never refreshed, so only the
 * server knows how much of it a (possibly multi-day, possibly resumed) upload
 * has already consumed. Returned by `/upload/complete` so the client never
 * displays or persists an expiry the server will not honor.
 *
 * A missing/absent TTL is reported as 0 rather than "forever": understating the
 * lifetime is the safe direction — it can only make a client refresh early.
 */
async function readRemainingLifetime(id: string): Promise<{ expiresAt: number; ttl: number }> {
    let ttlSeconds = 0;
    try {
        const raw = await storage.getTTL(id);
        if (Number.isFinite(raw) && raw > 0) {
            ttlSeconds = Math.trunc(raw);
        }
    } catch (e) {
        logger.warn({ id, error: e }, 'Failed to read remaining TTL');
    }
    return { expiresAt: Date.now() + ttlSeconds * 1000, ttl: ttlSeconds };
}

/**
 * Visitor IP for rate limiting. `cf-connecting-ip` first — Cloudflare sets it to
 * the real visitor and it survives edge rewrites of `x-forwarded-for`.
 */
export function clientIp(request: Request): string {
    const cf = request.headers.get('cf-connecting-ip');
    if (cf) {
        return cf.trim();
    }
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) {
            return first;
        }
    }
    return 'unknown';
}

export const uploadRoutes = new Elysia()
    // Get upload URL(s)
    .post(
        '/upload/url',
        async ({ body, request, set }) => {
            const { fileSize, encrypted, timeLimit, dlimit, preferredPartSize } = body;
            const requestId = randomBytes(4).toString('hex');

            logger.info(
                {
                    requestId,
                    fileSize,
                    fileSizeMB: Math.round((fileSize / (1024 * 1024)) * 100) / 100,
                    encrypted,
                    timeLimit,
                    dlimit,
                },
                'Upload URL request received',
            );

            // Rejections must carry a 4xx status — returned as HTTP 200 the
            // client's `response.ok` guard passes and the real reason is
            // replaced by an unrelated "Pre-signed URLs not available"
            if (!fileSize || fileSize < 0) {
                logger.warn({ requestId, fileSize }, 'Invalid file size');
                set.status = 400;
                return { error: 'Invalid file size' };
            }

            if (fileSize > config.maxFileSize) {
                logger.warn(
                    { requestId, fileSize, maxFileSize: config.maxFileSize },
                    'File size exceeds maximum',
                );
                set.status = 400;
                return { error: `File size exceeds maximum of ${config.maxFileSize} bytes` };
            }

            // Check if we can use pre-signed URLs
            logger.debug({ requestId }, 'Testing pre-signed URL generation');
            const testStartTime = Date.now();
            const testUploadUrl = await storage.getSignedUploadUrl('test');
            const testDuration = Date.now() - testStartTime;

            logger.info(
                {
                    requestId,
                    testDuration,
                    testSuccess: !!testUploadUrl,
                },
                'Pre-signed URL test completed',
            );

            if (!testUploadUrl) {
                captureError(new Error('Pre-signed URL test failed'), {
                    operation: 'upload.presign-test',
                    extra: {
                        requestId,
                        fileSize,
                        fileSizeMB: Math.round((fileSize / (1024 * 1024)) * 100) / 100,
                    },
                });
                logger.error(
                    { requestId },
                    'Pre-signed URL test failed, falling back to direct upload',
                );
                return { useSignedUrl: false };
            }

            // Generate file ID, owner token, and the upload-owner token that
            // gates abort/resume for this in-flight upload
            const id = randomBytes(8).toString('hex');
            const owner = randomBytes(10).toString('hex');
            const uploadToken = randomBytes(16).toString('hex');

            // Never log `owner`/`uploadToken` — they are bearer credentials for
            // /delete, /params, /password and abort/resume respectively
            logger.info({ requestId, id }, 'Generated file ID and owner token');

            // Calculate expiration. A non-positive or non-integer timeLimit must
            // never reach EXPIRE — EXPIRE(id, -1) deletes the key outright.
            const expireSeconds = clampExpireSeconds(timeLimit);
            const downloadLimit = clampDownloadLimit(dlimit);
            const prefix = Math.max(Math.floor(expireSeconds / 86400), 1);
            // Calculate object expiration date for S3 lifecycle
            const objectExpires = new Date(Date.now() + expireSeconds * 1000);

            logger.debug(
                { requestId, id, expireSeconds, prefix, objectExpires },
                'Calculated expiration',
            );

            // Store initial metadata
            logger.debug({ requestId, id }, 'Storing initial metadata in Redis');
            const redisStartTime = Date.now();

            const activeProviderId = storage.getActiveProviderId();
            await storage.setField(id, 'prefix', prefix.toString());
            await storage.setField(id, 'owner', owner);
            await storage.setField(id, 'encrypted', encrypted ? 'true' : 'false');
            await storage.setField(id, 'dl', '0');
            await storage.setField(id, 'dlimit', downloadLimit.toString());
            await storage.setField(id, 'fileSize', fileSize.toString());
            await storage.setField(id, 'providerId', activeProviderId);
            await storage.setField(id, 'uploadAuth', hashUploadToken(uploadToken));
            await storage.redis.expire(id, expireSeconds);
            await providerRegistry.incrementFileCount(activeProviderId);

            const redisDuration = Date.now() - redisStartTime;
            logger.info(
                { requestId, id, redisDuration, providerId: activeProviderId },
                'Initial metadata stored in Redis',
            );

            const useMultipart = fileSize > MULTIPART_THRESHOLD;
            logger.info(
                { requestId, id, useMultipart, threshold: MULTIPART_THRESHOLD },
                'Determined upload type',
            );

            if (useMultipart) {
                const { partSize, numParts } = calculateOptimalPartSize(
                    fileSize,
                    preferredPartSize,
                );

                logger.info(
                    {
                        requestId,
                        id,
                        fileSize,
                        partSize,
                        numParts,
                        urlExpirationDays: URL_EXPIRATION_SECONDS / 86400,
                        fileSizeGB: Math.round((fileSize / (1024 * 1024 * 1024)) * 100) / 100,
                        partSizeMB: Math.round(partSize / (1024 * 1024)),
                    },
                    'Multipart upload plan calculated',
                );

                // Create multipart upload (pinned to the provider captured above —
                // re-resolving "active" here could race a concurrent activation)
                logger.info({ requestId, id }, 'Creating multipart upload');
                const multipartStartTime = Date.now();
                const uploadId = await storage.createMultipartUpload(
                    id,
                    objectExpires,
                    activeProviderId,
                );
                const multipartDuration = Date.now() - multipartStartTime;

                if (!uploadId) {
                    captureError(new Error('Failed to create multipart upload'), {
                        operation: 'upload.multipart-create',
                        extra: { requestId, id, fileSize, numParts, partSize },
                    });
                    logger.error(
                        { requestId, id, multipartDuration },
                        'Failed to create multipart upload',
                    );
                    // Roll back the metadata written above — storage.del also
                    // decrements the provider file counter
                    await storage.del(id);
                    return { useSignedUrl: false };
                }

                logger.info(
                    { requestId, id, uploadId, multipartDuration },
                    'Multipart upload created',
                );

                // Generate URLs in parallel batches
                const BATCH_SIZE = 100;
                const parts: PartInfo[] = [];
                const urlGenStartTime = Date.now();

                logger.info(
                    { requestId, id, numParts, batchSize: BATCH_SIZE },
                    'Starting URL generation',
                );

                try {
                    for (let batchStart = 1; batchStart <= numParts; batchStart += BATCH_SIZE) {
                        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, numParts);
                        const batchPromises: Promise<PartInfo>[] = [];

                        logger.debug(
                            { requestId, id, batchStart, batchEnd },
                            'Processing URL batch',
                        );

                        for (let i = batchStart; i <= batchEnd; i++) {
                            batchPromises.push(
                                storage
                                    .getSignedMultipartUploadUrl(
                                        id,
                                        uploadId,
                                        i,
                                        URL_EXPIRATION_SECONDS,
                                        activeProviderId,
                                    )
                                    .then((url) => ({
                                        partNumber: i,
                                        url,
                                        minSize: i === numParts ? 0 : partSize,
                                        maxSize: partSize,
                                    })),
                            );
                        }

                        const batchParts = await Promise.all(batchPromises);
                        parts.push(...batchParts);

                        if (numParts > 100 || batchStart === 1) {
                            logger.info(
                                {
                                    requestId,
                                    id,
                                    generated: parts.length,
                                    total: numParts,
                                    percentage: Math.round((parts.length / numParts) * 100),
                                    elapsed: Date.now() - urlGenStartTime,
                                },
                                'URL generation progress',
                            );
                        }
                    }

                    // Store multipart upload info. These writes live INSIDE the
                    // rollback try: a transient Redis failure here used to 500
                    // without aborting the S3 multipart or rolling back the
                    // provider counter, and the client never learned the
                    // id/uploadId it would need to clean up itself.
                    await storage.setField(id, 'uploadId', uploadId);
                    await storage.setField(id, 'multipart', 'true');
                    await storage.setField(id, 'numParts', numParts.toString());
                    await storage.setField(id, 'partSize', partSize.toString());

                    // Register the object so the reaper can delete it (and abort
                    // an abandoned multipart) once the metadata TTL has passed
                    await scheduleObjectReap({
                        kind: 'file',
                        id,
                        providerId: activeProviderId,
                        uploadId,
                        expiresAt: objectExpires.getTime(),
                    });
                } catch (e) {
                    captureError(e, {
                        operation: 'upload.multipart-sign',
                        extra: { requestId, id, uploadId, numParts, generated: parts.length },
                    });
                    logger.error(
                        { requestId, id, uploadId, error: e },
                        'Failed to generate multipart upload URLs',
                    );
                    // Roll back so the S3 upload, Redis metadata, and provider
                    // file counter don't leak until TTL/lifecycle
                    await storage.abortMultipartUpload(id, uploadId, activeProviderId).catch(() => {
                        // Best-effort — the upload may already be gone
                    });
                    await storage.del(id);
                    await unscheduleObjectReap(id);
                    return { useSignedUrl: false };
                }

                const urlGenDuration = Date.now() - urlGenStartTime;
                logger.info(
                    {
                        requestId,
                        id,
                        numParts,
                        urlGenDuration,
                        avgTimePerUrl: Math.round((urlGenDuration / numParts) * 100) / 100,
                    },
                    'All upload URLs generated',
                );

                const response = {
                    useSignedUrl: true,
                    multipart: true,
                    id,
                    owner,
                    uploadToken,
                    uploadId,
                    parts,
                    partSize,
                    url: `${deriveBaseUrl(request)}/download/${id}#${owner}`,
                };

                logger.info(
                    {
                        requestId,
                        id,
                        uploadId,
                        numParts,
                        partSize,
                        totalTime: Date.now() - testStartTime,
                    },
                    'Multipart upload response ready',
                );

                return response;
            } else {
                // Single part upload — same 7-day URL validity as multipart parts
                // (the previous 1-hour default could expire mid-upload on slow links)
                logger.info({ requestId, id }, 'Generating single upload URL');
                const singleUrlStartTime = Date.now();
                const uploadUrl = await storage.getSignedUploadUrl(
                    id,
                    URL_EXPIRATION_SECONDS,
                    objectExpires,
                    activeProviderId,
                );
                const singleUrlDuration = Date.now() - singleUrlStartTime;

                // The signed URL is a PUT credential — log its length only
                logger.info(
                    {
                        requestId,
                        id,
                        singleUrlDuration,
                        urlLength: uploadUrl?.length,
                    },
                    'Single upload URL generated',
                );

                if (!uploadUrl) {
                    // Never hand the client { useSignedUrl: true, url: null } —
                    // roll back the metadata + provider counter and signal fallback
                    logger.error({ requestId, id }, 'Failed to sign single upload URL');
                    await storage.del(id);
                    return { useSignedUrl: false };
                }

                await scheduleObjectReap({
                    kind: 'file',
                    id,
                    providerId: activeProviderId,
                    expiresAt: objectExpires.getTime(),
                });

                const response = {
                    useSignedUrl: true,
                    multipart: false,
                    id,
                    owner,
                    uploadToken,
                    url: uploadUrl,
                    completeUrl: `${deriveBaseUrl(request)}/download/${id}#${owner}`,
                };

                logger.info(
                    {
                        requestId,
                        id,
                        totalTime: Date.now() - testStartTime,
                    },
                    'Single upload response ready',
                );

                return response;
            }
        },
        {
            detail: {
                tags: ['Upload'],
                summary: 'Request upload URL(s)',
                description:
                    'Generates pre-signed S3 upload URLs. Returns a single URL for small files or multipart upload URLs for files exceeding the multipart threshold. The returned `uploadToken` authorizes aborting or resuming this upload and must be kept secret by the uploader.',
            },
            body: t.Object({
                fileSize: t.Number(),
                encrypted: t.Optional(t.Boolean()),
                // Positive integers only — a negative timeLimit reaches EXPIRE
                // as a delete, and a non-integer dlimit corrupts the stored
                // value on the parseInt round-trip
                timeLimit: t.Optional(t.Integer({ minimum: 1 })),
                dlimit: t.Optional(t.Integer({ minimum: 1 })),
                preferredPartSize: t.Optional(t.Number()),
            }),
            response: {
                200: t.Object({
                    useSignedUrl: t.Optional(t.Boolean()),
                    multipart: t.Optional(t.Boolean()),
                    id: t.Optional(t.String()),
                    owner: t.Optional(t.String()),
                    uploadToken: t.Optional(t.String()),
                    url: t.Optional(t.Union([t.String(), t.Null()])),
                    uploadId: t.Optional(t.String()),
                    parts: t.Optional(
                        t.Array(
                            t.Object({
                                partNumber: t.Number(),
                                url: t.String(),
                                minSize: t.Number(),
                                maxSize: t.Number(),
                            }),
                        ),
                    ),
                    partSize: t.Optional(t.Number()),
                    completeUrl: t.Optional(t.String()),
                    error: t.Optional(t.String()),
                }),
                400: t.Object({
                    error: t.String(),
                }),
            },
        },
    )

    // Complete upload
    .post(
        '/upload/complete',
        async ({ body, request, set }) => {
            const { id, metadata, authKey, actualSize, parts } = body;
            const requestId = randomBytes(4).toString('hex');

            logger.info(
                {
                    requestId,
                    id,
                    hasMetadata: !!metadata,
                    hasAuthKey: !!authKey,
                    actualSize,
                    partsCount: parts?.length,
                },
                'Upload complete request received',
            );

            if (!id) {
                logger.warn({ requestId }, 'Missing file ID');
                set.status = 400;
                return { error: 'Missing file ID' };
            }

            logger.debug({ requestId, id }, 'Fetching file metadata');
            const fileInfo = await storage.getMetadata(id);

            if (!fileInfo) {
                logger.warn({ requestId, id }, 'File not found in Redis');
                set.status = 404;
                return { error: 'File not found', status: 404 };
            }

            logger.debug({ requestId, id, fileInfo }, 'File metadata retrieved');

            // A stored auth field means this upload already completed. The file ID
            // becomes public once the link is shared, so an unauthenticated
            // re-completion must never overwrite auth/metadata (an attacker could
            // lock recipients out or deface the file). A retry carrying the same
            // authKey is the uploader recovering from a lost response — idempotent.
            if (fileInfo.auth) {
                if (fileInfo.encrypted) {
                    const provided = Buffer.from(typeof authKey === 'string' ? authKey : '');
                    const stored = Buffer.from(fileInfo.auth);
                    const sameKey =
                        provided.length === stored.length && timingSafeEqual(provided, stored);
                    if (!sameKey) {
                        logger.warn(
                            { requestId, id },
                            'Rejected re-completion with mismatched auth key',
                        );
                        set.status = 401;
                        return { error: 'Upload already completed' };
                    }
                }
                logger.info({ requestId, id }, 'Upload already completed — idempotent retry');
                const retryLifetime = await readRemainingLifetime(id);
                return {
                    success: true,
                    id,
                    url: `${deriveBaseUrl(request)}/download/${id}`,
                    ...retryLifetime,
                };
            }

            // Reject invalid encrypted-file requests before the S3 completion,
            // otherwise the object gets finalized but is permanently 401
            if (fileInfo.encrypted && (!authKey || typeof authKey !== 'string')) {
                logger.warn({ requestId, id }, 'Missing or invalid auth key for encrypted file');
                set.status = 400;
                return { error: 'Missing or invalid auth key for encrypted file' };
            }

            // MAX_FILES_PER_ARCHIVE (audit #5) is advertised via GET /config but
            // was never enforced. The count only reaches the server inside the
            // metadata blob, and only an unencrypted blob is inspectable — so
            // gate here, before any S3 completion, so a rejected upload is never
            // finalized. The multipart stays abortable and the reaper (#42)
            // sweeps it. A client can evade by sending unparseable metadata or
            // by claiming to be encrypted, but both break its own download page,
            // so the gate holds for every share that actually works.
            // Byte cap on the stored blob, checked before the file-count gate
            // and before any S3 completion. This is the bound the archive
            // limit was only ever a proxy for: the blob lands in Redis and is
            // re-served by /metadata/:id on every download-page load, the
            // route schema is an unbounded `t.String()`, and — unlike
            // MAX_FILES_PER_ARCHIVE — it applies to encrypted shares too,
            // whose ciphertext metadata cannot be counted without breaking
            // E2E. Base64 is ASCII, so string length is byte length.
            if (typeof metadata === 'string' && metadata.length > config.maxMetadataBytes) {
                logger.warn(
                    { requestId, id, metadataBytes: metadata.length, max: config.maxMetadataBytes },
                    'Rejected completion exceeding MAX_METADATA_BYTES',
                );
                set.status = 400;
                return {
                    error: `Metadata too large: ${metadata.length} bytes exceeds the limit of ${config.maxMetadataBytes}`,
                };
            }

            if (!fileInfo.encrypted && typeof metadata === 'string' && metadata.length > 0) {
                const declaredFiles = countDeclaredFiles(metadata);
                if (declaredFiles !== null && declaredFiles > config.maxFilesPerArchive) {
                    logger.warn(
                        { requestId, id, declaredFiles, max: config.maxFilesPerArchive },
                        'Rejected completion exceeding MAX_FILES_PER_ARCHIVE',
                    );
                    set.status = 400;
                    return {
                        error: `Too many files: ${declaredFiles} exceeds the limit of ${config.maxFilesPerArchive}`,
                    };
                }
            }

            const isMultipart = fileInfo.multipart;

            if (isMultipart) {
                logger.info(
                    { requestId, id, isMultipart: true },
                    'Processing multipart upload completion',
                );

                if (!parts || !Array.isArray(parts)) {
                    logger.warn({ requestId, id }, 'Missing parts data for multipart upload');
                    set.status = 400;
                    return { error: 'Missing parts data' };
                }

                // Allow completion with fewer parts than allocated (stream ended early)
                const expectedParts = fileInfo.numParts || 0;
                if (parts.length > expectedParts) {
                    logger.warn(
                        {
                            requestId,
                            id,
                            receivedParts: parts.length,
                            expectedParts,
                        },
                        'Too many parts received',
                    );
                    set.status = 400;
                    return {
                        error: `Too many parts: got ${parts.length}, expected at most ${expectedParts}`,
                    };
                }

                const uploadId = fileInfo.uploadId;
                if (!uploadId) {
                    logger.error({ requestId, id }, 'Upload ID not found in metadata');
                    set.status = 500;
                    return { error: 'Upload ID not found' };
                }

                // Sort and convert parts to AWS format
                const sortedParts: CompletedPart[] = parts
                    .sort((a, b) => a.PartNumber - b.PartNumber)
                    .map((p) => ({
                        PartNumber: p.PartNumber,
                        ETag: p.ETag,
                    }));

                // Every legitimate client path produces parts numbered 1..k with no
                // gaps (fewer than allocated is fine — the stream may end early).
                // S3 would happily complete a gapped list, producing a silently
                // corrupt object with missing byte ranges, so reject it here.
                if (sortedParts.length === 0) {
                    logger.warn({ requestId, id }, 'Empty parts list for multipart upload');
                    set.status = 400;
                    return { error: 'Missing parts data' };
                }
                const nonContiguous = sortedParts.some((p, idx) => p.PartNumber !== idx + 1);
                if (nonContiguous) {
                    logger.warn(
                        {
                            requestId,
                            id,
                            partNumbers: sortedParts.map((p) => p.PartNumber),
                        },
                        'Non-contiguous or duplicate part numbers in completion request',
                    );
                    set.status = 400;
                    return {
                        error: 'Invalid parts list: part numbers must be contiguous starting at 1',
                        status: 400,
                    };
                }

                logger.info(
                    {
                        requestId,
                        id,
                        uploadId,
                        partsReceived: parts.length,
                        partsAllocated: expectedParts,
                        firstPart: sortedParts[0],
                        lastPart: sortedParts[sortedParts.length - 1],
                    },
                    'Completing multipart upload',
                );

                try {
                    const completeStartTime = Date.now();
                    await storage.completeMultipartUpload(
                        id,
                        uploadId,
                        sortedParts,
                        fileInfo.providerId,
                    );
                    const completeDuration = Date.now() - completeStartTime;

                    logger.info(
                        {
                            requestId,
                            id,
                            uploadId,
                            completeDuration,
                        },
                        'Multipart upload completed successfully',
                    );
                } catch (e: unknown) {
                    const err = e as Error & { code?: string };
                    // AWS SDK v3 puts S3 error codes in err.name, not err.code
                    const errorCode = err.name || err.code;
                    captureError(e, {
                        operation: 'upload.multipart-complete',
                        extra: {
                            requestId,
                            id,
                            uploadId,
                            partsReceived: parts.length,
                            partsAllocated: expectedParts,
                            errorCode,
                            errorName: err.name,
                        },
                    });
                    logger.error(
                        {
                            requestId,
                            id,
                            uploadId,
                            error: e,
                            errorName: err.name,
                            errorMessage: err.message,
                            errorCode,
                        },
                        'Failed to complete multipart upload',
                    );

                    // Provide specific error messages
                    // AWS SDK v3 uses err.name for S3 error codes (e.g. "EntityTooSmall"),
                    // while err.code may be undefined. Check both for compatibility.
                    if (errorCode === 'NoSuchUpload') {
                        // NoSuchUpload can mean the completion already committed: the
                        // SDK may retry a CompleteMultipartUpload whose response was
                        // lost, or an earlier request may have crashed after the S3
                        // call but before the auth write. If the object exists, keep
                        // going and finalize metadata/auth — returning 404 here would
                        // strand a fully-uploaded object as a permanently dead file.
                        const alreadyFinalized = await storage
                            .length(id)
                            .then((len) => len > 0)
                            .catch(() => false);
                        if (!alreadyFinalized) {
                            set.status = 404;
                            return { error: 'Upload not found or expired', status: 404 };
                        }
                        logger.warn(
                            { requestId, id, uploadId },
                            'Multipart upload already finalized at S3 — continuing completion',
                        );
                    } else if (errorCode === 'InvalidPart' || errorCode === 'InvalidPartOrder') {
                        set.status = 400;
                        return { error: 'Invalid upload parts', status: 400 };
                    } else if (errorCode === 'EntityTooSmall') {
                        set.status = 400;
                        return {
                            error: 'One or more upload parts are smaller than the 5MB minimum. This can happen on iOS when the browser transcodes media files during upload. Please try again.',
                            status: 400,
                        };
                    } else {
                        throw e;
                    }
                }

                // Clean up multipart metadata
                await storage.redis.hDel(id, 'uploadId', 'multipart', 'numParts');
                logger.debug({ requestId, id }, 'Cleaned up multipart metadata');
            }

            // Bind the recorded size to the bytes S3 actually holds. Both the
            // declared `fileSize` and the reported `actualSize` are client
            // controlled: nothing in the pre-signed PUT/UploadPart constrains
            // how much a modified client uploads, so the only trustworthy
            // number is the object's own Content-Length.
            let storedSize: number | null = null;
            try {
                const headSize = await storage.length(id);
                if (Number.isFinite(headSize) && headSize > 0) {
                    storedSize = headSize;
                }
            } catch (e) {
                // A HEAD blip must not fail an otherwise-good upload; fall back
                // to the client-reported size (still bounded at /upload/url)
                logger.warn(
                    { requestId, id, error: e },
                    'Could not HEAD completed object — falling back to reported size',
                );
            }

            if (storedSize !== null && storedSize > config.maxFileSize) {
                captureError(new Error('Stored object exceeds maximum file size'), {
                    operation: 'upload.size-limit',
                    extra: { requestId, id, storedSize, maxFileSize: config.maxFileSize },
                    level: 'warning',
                });
                logger.warn(
                    { requestId, id, storedSize, maxFileSize: config.maxFileSize },
                    'Stored object exceeds maximum file size — deleting',
                );
                // Delete the object AND the metadata: leaving either behind
                // would keep the over-size bytes billable and downloadable
                await storage.del(id).catch((delErr) => {
                    logger.error(
                        { requestId, id, error: delErr },
                        'Failed to delete over-size object',
                    );
                });
                await unscheduleObjectReap(id);
                set.status = 413;
                return {
                    error: `Stored file exceeds maximum of ${config.maxFileSize} bytes`,
                    status: 413,
                };
            }

            // Collect every finalization write and apply them under a single
            // EXISTS guard. A plain HSET on a key that TTL-expired during the
            // (potentially very long) CompleteMultipartUpload would resurrect it
            // as an immortal hash with no owner and no providerId.
            const finalFields: Record<string, string> = {};

            if (metadata && typeof metadata === 'string') {
                finalFields.metadata = metadata;
            }

            if (fileInfo.encrypted) {
                // Safety net — already validated before the S3 completion above
                if (!authKey || typeof authKey !== 'string') {
                    logger.warn(
                        { requestId, id },
                        'Missing or invalid auth key for encrypted file',
                    );
                    set.status = 400;
                    return { error: 'Missing or invalid auth key for encrypted file' };
                }
                finalFields.auth = authKey;
                finalFields.nonce = randomBytes(16).toString('base64');
            } else {
                finalFields.auth = 'unencrypted';
                finalFields.nonce = '';
            }

            const resolvedSize = storedSize ?? (actualSize ? Math.trunc(actualSize) : null);
            if (resolvedSize !== null && resolvedSize >= 0) {
                finalFields.fileSize = resolvedSize.toString();
            }

            const written = await storage.redis.hSetIfExists(id, finalFields);
            if (!written) {
                logger.warn(
                    { requestId, id },
                    'File metadata expired during completion — refusing to resurrect it',
                );
                set.status = 404;
                return { error: 'File not found', status: 404 };
            }

            logger.info(
                {
                    requestId,
                    id,
                    multipart: isMultipart,
                    encrypted: fileInfo.encrypted,
                    storedSize,
                },
                'Upload completed successfully',
            );

            // Report the AUTHORITATIVE remaining lifetime. The TTL starts at
            // /upload/url, not here — a long or resumed upload can burn days of
            // it — so a client computing `now + timeLimit` would show (and
            // persist) an expiry the server will not honor.
            const lifetime = await readRemainingLifetime(id);

            // No fragment here — the real key never leaves the client, and the
            // owner token must not leak into a shareable URL
            return {
                success: true,
                id,
                url: `${deriveBaseUrl(request)}/download/${id}`,
                ...lifetime,
            };
        },
        {
            detail: {
                tags: ['Upload'],
                summary: 'Complete file upload',
                description:
                    'Finalizes an upload by completing the S3 multipart upload (if applicable), verifying the stored object size, storing file metadata, and setting authentication. Returns the authoritative remaining lifetime (`ttl` in seconds, `expiresAt` in epoch milliseconds) — the TTL starts when the upload URL is issued, so clients must not compute the expiry themselves.',
            },
            body: t.Object({
                id: t.String(),
                metadata: t.Optional(t.String()),
                authKey: t.Optional(t.String()),
                actualSize: t.Optional(t.Number()),
                parts: t.Optional(
                    t.Array(
                        t.Object({
                            PartNumber: t.Number(),
                            ETag: t.String(),
                        }),
                    ),
                ),
            }),
            response: {
                200: t.Object({
                    success: t.Optional(t.Boolean()),
                    id: t.Optional(t.String()),
                    url: t.Optional(t.String()),
                    // Authoritative remaining lifetime — see route description
                    expiresAt: t.Optional(t.Number()),
                    ttl: t.Optional(t.Number()),
                    error: t.Optional(t.String()),
                    status: t.Optional(t.Number()),
                }),
                400: t.Object({
                    error: t.String(),
                    status: t.Optional(t.Number()),
                }),
                401: t.Object({
                    error: t.String(),
                }),
                404: t.Object({
                    error: t.String(),
                    status: t.Optional(t.Number()),
                }),
                413: t.Object({
                    error: t.String(),
                    status: t.Optional(t.Number()),
                }),
                500: t.Object({
                    error: t.String(),
                }),
            },
        },
    )

    // Abort multipart upload
    .post(
        '/upload/abort/:id',
        async ({ params, body, set }) => {
            const { id } = params;
            const { uploadId, uploadToken } = body;
            const requestId = randomBytes(4).toString('hex');

            logger.info({ requestId, id, uploadId }, 'Abort upload request received');

            if (!uploadId) {
                logger.warn({ requestId, id }, 'Missing upload ID');
                return { error: 'Missing upload ID' };
            }

            const fileInfo = await storage.getMetadata(id);

            if (fileInfo) {
                // Only the uploader may abort (enforced once UPLOAD_TOKEN_ENFORCED
                // is on; logged-and-allowed until the client sends the token)
                if (!(await authorizeUploadMutation(id, uploadToken, 'abort', requestId))) {
                    set.status = 401;
                    return { error: 'Invalid upload token' };
                }

                // Don't pass an arbitrary uploadId through to S3: it must be the
                // one this file was actually created with
                if (fileInfo.uploadId && fileInfo.uploadId !== uploadId) {
                    logger.warn({ requestId, id }, 'Abort rejected — upload ID mismatch');
                    set.status = 400;
                    return { error: 'Upload ID mismatch' };
                }
            }

            try {
                await storage.abortMultipartUpload(id, uploadId, fileInfo?.providerId);
                // storage.del (not redis.del) so the provider file counter
                // incremented at /upload/url is decremented again
                await storage.del(id);
                await unscheduleObjectReap(id);
                logger.info({ requestId, id, uploadId }, 'Upload aborted successfully');
                return { success: true };
            } catch (e) {
                captureError(e, {
                    operation: 'upload.abort',
                    extra: { requestId, id, uploadId },
                    level: 'warning',
                });
                logger.error(
                    { requestId, id, uploadId, error: e },
                    'Failed to abort multipart upload',
                );
                return { error: 'Failed to abort upload' };
            }
        },
        {
            detail: {
                tags: ['Upload'],
                summary: 'Abort multipart upload',
                description:
                    'Aborts an in-progress multipart upload, cleaning up uploaded parts from S3 and removing metadata from Redis. Send the `uploadToken` issued by `/upload/url`; a missing or wrong token is logged and allowed until the deployment sets `UPLOAD_TOKEN_ENFORCED=true`, after which it is rejected with 401.',
            },
            body: t.Object({
                uploadId: t.String(),
                uploadToken: t.Optional(t.String()),
            }),
            response: {
                200: t.Object({
                    success: t.Optional(t.Boolean()),
                    error: t.Optional(t.String()),
                }),
                400: t.Object({
                    error: t.String(),
                }),
                401: t.Object({
                    error: t.String(),
                }),
            },
        },
    )

    // Resume multipart upload — generate pre-signed URLs for remaining parts
    .post(
        '/upload/multipart/:id/resume',
        async ({ params, body, set }) => {
            const { id } = params;
            const { uploadId, uploadToken, completedPartNumbers } = body;
            const requestId = randomBytes(4).toString('hex');

            logger.info(
                { requestId, id, uploadId, completedCount: completedPartNumbers.length },
                'Resume upload request received',
            );

            // Verify upload exists in Redis
            const fileInfo = await storage.getMetadata(id);
            if (!fileInfo) {
                logger.warn({ requestId, id }, 'File not found for resume');
                set.status = 404;
                return { error: 'Upload not found or expired' };
            }

            // Only the uploader may mint fresh pre-signed PUT URLs for the
            // unfinished parts — otherwise anyone holding a leaked uploadId
            // could inject bytes into the object before the uploader completes.
            // Enforced once UPLOAD_TOKEN_ENFORCED is on; until then an unverified
            // resume is logged and allowed, because the client destroys its
            // IndexedDB resume state on any non-OK response.
            if (!(await authorizeUploadMutation(id, uploadToken, 'resume', requestId))) {
                set.status = 401;
                return { error: 'Invalid upload token' };
            }

            if (!fileInfo.uploadId || fileInfo.uploadId !== uploadId) {
                logger.warn({ requestId, id }, 'Upload ID mismatch');
                set.status = 400;
                return { error: 'Upload ID mismatch' };
            }

            const numParts = fileInfo.numParts || 0;
            const partSize = Number(fileInfo.partSize || DEFAULT_PART_SIZE);
            const completedSet = new Set(completedPartNumbers);

            // Generate pre-signed URLs for parts NOT in completedPartNumbers
            const parts: PartInfo[] = [];
            const BATCH_SIZE = 100;

            for (let batchStart = 1; batchStart <= numParts; batchStart += BATCH_SIZE) {
                const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, numParts);
                const batchPromises: Promise<PartInfo | null>[] = [];

                for (let i = batchStart; i <= batchEnd; i++) {
                    if (completedSet.has(i)) {
                        continue;
                    }
                    batchPromises.push(
                        storage
                            .getSignedMultipartUploadUrl(
                                id,
                                uploadId,
                                i,
                                URL_EXPIRATION_SECONDS,
                                fileInfo.providerId,
                            )
                            .then((url) => ({
                                partNumber: i,
                                url,
                                minSize: i === numParts ? 0 : partSize,
                                maxSize: partSize,
                            })),
                    );
                }

                const batchParts = await Promise.all(batchPromises);
                parts.push(...(batchParts.filter(Boolean) as PartInfo[]));
            }

            logger.info(
                { requestId, id, remainingParts: parts.length, totalParts: numParts },
                'Resume URLs generated',
            );

            return { parts, partSize, numParts };
        },
        {
            detail: {
                tags: ['Upload'],
                summary: 'Resume multipart upload',
                description:
                    'Generates new pre-signed URLs for remaining parts of an interrupted multipart upload. Skips already-uploaded parts. Send the `uploadToken` issued by `/upload/url`; a missing or wrong token is logged and allowed until the deployment sets `UPLOAD_TOKEN_ENFORCED=true`, after which it is rejected with 401.',
            },
            body: t.Object({
                uploadId: t.String(),
                uploadToken: t.Optional(t.String()),
                completedPartNumbers: t.Array(t.Number()),
            }),
            response: {
                200: t.Object({
                    parts: t.Array(
                        t.Object({
                            partNumber: t.Number(),
                            url: t.String(),
                            minSize: t.Number(),
                            maxSize: t.Number(),
                        }),
                    ),
                    partSize: t.Number(),
                    numParts: t.Number(),
                }),
                400: t.Object({ error: t.String() }),
                401: t.Object({ error: t.String() }),
                404: t.Object({ error: t.String() }),
            },
        },
    )

    // Speed test — creates a multipart upload with 5 pre-signed part URLs.
    // The client uploads 5x100MB parts concurrently to measure real throughput.
    .post(
        '/upload/speedtest',
        async ({ request, set }) => {
            const SPEEDTEST_NUM_PARTS = 5;
            const testId = `${SPEEDTEST_PREFIX}${randomBytes(8).toString('hex')}`;

            // Unauthenticated write amplification: each call mints 5 unbounded
            // pre-signed UploadPart URLs, so an unthrottled loop can park
            // terabytes of list-invisible incomplete-multipart data in the bucket
            if (!speedTestRateLimiter.take(clientIp(request))) {
                logger.warn({ testId }, 'Speed test rate limit exceeded');
                set.status = 429;
                return { error: 'Too many speed test requests' };
            }

            // Pin the provider for the whole test so cleanup can't abort against
            // a different bucket after a concurrent provider activation
            const providerId = storage.getActiveProviderId();

            let uploadId: string | null = null;
            try {
                uploadId = await storage.createMultipartUpload(testId, undefined, providerId);
                if (!uploadId) {
                    return { error: 'Failed to create speed test upload' };
                }

                const parts = await Promise.all(
                    Array.from({ length: SPEEDTEST_NUM_PARTS }, (_, i) =>
                        storage
                            .getSignedMultipartUploadUrl(
                                testId,
                                uploadId as string,
                                i + 1,
                                60,
                                providerId,
                            )
                            .then((url) => ({ partNumber: i + 1, url })),
                    ),
                );

                // Cleanup must not depend on the client coming back: register the
                // test so the reaper aborts it if /speedtest/cleanup never arrives
                await scheduleObjectReap({
                    kind: 'speedtest',
                    id: testId,
                    providerId,
                    uploadId,
                    expiresAt: Date.now() + SPEEDTEST_REAP_AFTER_MS,
                });

                logger.info(
                    { testId, uploadId, numParts: SPEEDTEST_NUM_PARTS, providerId },
                    'Speed test URLs generated',
                );
                return { testId, uploadId, parts };
            } catch (e) {
                logger.warn({ testId, error: e }, 'Speed test setup failed');
                if (uploadId) {
                    await storage
                        .abortMultipartUpload(testId, uploadId, providerId)
                        .catch(() => undefined);
                }
                return { error: 'Speed test setup failed' };
            }
        },
        {
            detail: {
                tags: ['Speed Test'],
                summary: 'Start upload speed test',
                description:
                    'Creates a temporary multipart upload with 5 pre-signed part URLs for measuring upload throughput. Rate limited per client IP; abandoned tests are swept server-side.',
            },
            response: {
                200: t.Object({
                    testId: t.Optional(t.String()),
                    uploadId: t.Optional(t.String()),
                    parts: t.Optional(
                        t.Array(
                            t.Object({
                                partNumber: t.Number(),
                                url: t.String(),
                            }),
                        ),
                    ),
                    error: t.Optional(t.String()),
                }),
                429: t.Object({
                    error: t.String(),
                }),
            },
        },
    )

    // Clean up speed test object after the test completes
    .post(
        '/upload/speedtest/cleanup',
        async ({ body, set }) => {
            const { testId, uploadId } = body;

            // This route aborts an arbitrary uploadId — restrict it to keys the
            // speed test could actually have created
            if (!testId.startsWith(SPEEDTEST_PREFIX)) {
                logger.warn({ testId }, 'Speed test cleanup rejected — not a speed test id');
                set.status = 400;
                return { ok: false, error: 'Invalid speed test id' };
            }

            // Use the provider pinned at creation time; resolving "active" here
            // would abort against the wrong bucket after a provider change and
            // leak the real test parts behind a swallowed NoSuchUpload
            const record = await getReapRecord(testId);

            let cleaned = true;
            try {
                // Abort the multipart upload (cleans up parts from S3)
                const effectiveUploadId = uploadId || record?.uploadId;
                if (effectiveUploadId) {
                    await storage.abortMultipartUpload(
                        testId,
                        effectiveUploadId,
                        record?.providerId,
                    );
                }
                logger.info({ testId }, 'Speed test cleaned up');
            } catch (e) {
                cleaned = false;
                logger.warn({ testId, error: e }, 'Failed to clean up speed test');
            }

            // Drop the sweep record only if the abort actually succeeded —
            // otherwise leave it so the reaper retries the cleanup
            if (cleaned) {
                await unscheduleObjectReap(testId);
            }
            return { ok: true };
        },
        {
            detail: {
                tags: ['Speed Test'],
                summary: 'Clean up speed test',
                description:
                    'Aborts the temporary multipart upload created by the speed test, removing all test parts from S3.',
            },
            body: t.Object({
                testId: t.String(),
                uploadId: t.Optional(t.String()),
            }),
            response: {
                200: t.Object({
                    ok: t.Boolean(),
                }),
                400: t.Object({
                    ok: t.Boolean(),
                    error: t.String(),
                }),
            },
        },
    );
