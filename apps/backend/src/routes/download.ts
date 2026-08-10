import { Elysia, t } from 'elysia';
import { clampDownloadLimit } from '../lib/download-limit';
import { captureError } from '../lib/sentry';
import { downloadLogger as logger } from '../logger';
import { verifyAuth, verifyOwner } from '../middleware/auth';
import { storage } from '../storage';

/**
 * `S3Storage.getStream` tags the stream it returns with the object's
 * `ContentLength`; the storage facade passes the object straight through, so
 * read the tag defensively here. Emitting `Content-Length` on the fallback
 * stream routes is what lets the client's truncation guard fire — a chunked
 * response reports `contentLength === 0` and the guard is skipped.
 */
export function streamContentLength(stream: ReadableStream<Uint8Array>): number | undefined {
    const { contentLength } = stream as ReadableStream<Uint8Array> & { contentLength?: unknown };
    const usable =
        typeof contentLength === 'number' && Number.isFinite(contentLength) && contentLength >= 0;
    return usable ? contentLength : undefined;
}

/**
 * Schedule deletion of a limit-reached file after a 5-minute grace window.
 * The timer re-checks the limit at fire time (the owner may have raised
 * dlimit via /params meanwhile). As a restart-surviving backstop the metadata
 * TTL is capped to the same window, preserving the original expiry in an
 * `expiresAt` field so /params can restore it.
 *
 * The TTL-cap chain is awaited before the caller responds: if `expiresAt` were
 * written lazily, a `/params` raise landing in that window would read a null
 * `expiresAt`, skip the TTL restore, and let the metadata expire at ~300s while
 * the grace timer preserves the object — orphaning it in the bucket.
 */
async function scheduleLimitDeletion(id: string): Promise<void> {
    setTimeout(() => {
        storage
            .getMetadata(id)
            .then((current) => {
                if (!current || current.dl < current.dlimit) {
                    return;
                }
                return storage.del(id);
            })
            .catch((e) => {
                captureError(e, {
                    operation: 'download.delayed-delete',
                    extra: { id },
                    level: 'warning',
                });
            });
    }, 300000); // 5 min delay

    try {
        const ttl = await storage.getTTL(id);
        if (ttl > 300) {
            await storage.setField(id, 'expiresAt', String(Math.floor(Date.now() / 1000) + ttl));
            await storage.redis.expire(id, 300);
        }
    } catch {
        // Non-critical — natural TTL still applies
    }
}

/**
 * Re-read the current download limit straight from Redis.
 *
 * Callers that increment and then decide whether to destroy the file must not
 * judge against the `dlimit` snapshot taken before the increment — the owner
 * may have raised it via `/params` in that window, and deleting against the
 * stale value permanently destroys a file whose live limit is not reached.
 * Falls back to the snapshot when the field is missing or unparseable.
 */
async function readCurrentDownloadLimit(id: string, fallback: number): Promise<number> {
    try {
        const raw = await storage.getField(id, 'dlimit');
        if (raw === null) {
            return fallback;
        }
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    } catch (e) {
        captureError(e, {
            operation: 'download.reread-dlimit',
            extra: { id },
            level: 'warning',
        });
        return fallback;
    }
}

export const downloadRoutes = new Elysia()
    // Direct download for unencrypted single files (redirects to S3)
    .get(
        '/download/direct/:id',
        async ({ params, set, redirect }) => {
            const { id } = params;

            const metadata = await storage.getMetadata(id);
            if (!metadata) {
                set.status = 404;
                return { error: 'File not found' };
            }

            // Only allow direct download for unencrypted files
            if (metadata.encrypted) {
                set.status = 400;
                return { error: 'Direct download not available for encrypted files' };
            }

            // Decode metadata to get filename
            let filename = 'download';
            if (metadata.metadata) {
                try {
                    // Handle URL-safe base64 by converting to standard base64
                    const standardB64 = metadata.metadata.replace(/-/g, '+').replace(/_/g, '/');
                    // Add padding if needed
                    const padded = standardB64 + '==='.slice(0, (4 - (standardB64.length % 4)) % 4);
                    const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));

                    // Multi-file uploads that were zipped are fine for direct download
                    // Only reject legacy multi-file uploads that weren't zipped
                    if (decoded.files?.length > 1 && !decoded.zipped) {
                        set.status = 400;
                        return {
                            error: 'Direct download not available for legacy multi-file uploads',
                        };
                    }

                    // Use zip filename for zipped uploads, otherwise first file's name
                    if (decoded.zipped && decoded.zipFilename) {
                        filename = decoded.zipFilename;
                    } else {
                        filename = decoded.files?.[0]?.name || decoded.name || 'download';
                    }
                } catch (e) {
                    captureError(e, {
                        operation: 'download.metadata-decode',
                        extra: { id, metadataLength: metadata.metadata?.length },
                    });
                    logger.warn({ id, error: e }, 'Failed to decode metadata for direct download');
                }
            }

            // Check if download limit already reached
            if (metadata.dl >= metadata.dlimit) {
                set.status = 410;
                return { error: 'Download limit reached' };
            }

            // Sign before incrementing so a signing failure doesn't burn a credit
            const signedUrl = await storage.getSignedDownloadUrl(id, filename);
            if (!signedUrl) {
                captureError(new Error('Failed to generate signed download URL'), {
                    operation: 'download.sign-url',
                    extra: { id, filename },
                });
                set.status = 500;
                return { error: 'Failed to generate download URL' };
            }

            // Increment counter before redirect
            const newDl = await storage.incrementDownloadCount(id);

            // Check if limit exceeded after increment (concurrent downloads)
            if (newDl > metadata.dlimit) {
                set.status = 410;
                return { error: 'Download limit reached' };
            }

            // Schedule deletion if limit reached
            if (newDl >= metadata.dlimit) {
                logger.info(
                    { id, dl: newDl, dlimit: metadata.dlimit },
                    'Download limit reached, scheduling deletion',
                );
                await scheduleLimitDeletion(id);
            }

            // Redirect to S3
            return redirect(signedUrl, 302);
        },
        {
            detail: {
                tags: ['Download'],
                summary: 'Direct download (redirect)',
                description:
                    'Redirects to a pre-signed S3 URL for direct download. Only available for unencrypted files. Increments the download counter.',
            },
        },
    )

    // Get download URL (with optional pre-signed URL for direct download)
    .get(
        '/download/url/:id',
        async ({ params, headers, set }) => {
            const { id } = params;
            const authHeader = headers.authorization || null;

            const metadata = await storage.getMetadata(id);
            if (!metadata) {
                set.status = 404;
                return { error: 'File not found' };
            }

            // Verify authentication for encrypted files
            if (metadata.encrypted) {
                const { valid, nonce } = await verifyAuth(id, authHeader);
                set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

                if (!valid) {
                    set.status = 401;
                    return { error: 'Authentication required' };
                }
            }

            // At the limit, return counts without minting a URL (200, not 410):
            // clients old and new gate on dl >= dlimit themselves, and older
            // deployed frontends treat any non-ok response as "status unknown"
            if (metadata.dl >= metadata.dlimit) {
                return {
                    useSignedUrl: false,
                    dl: metadata.dl,
                    dlimit: metadata.dlimit,
                };
            }

            // Get pre-signed download URL
            const signedUrl = await storage.getSignedDownloadUrl(id);
            if (!signedUrl) {
                captureError(new Error('Failed to generate signed download URL'), {
                    operation: 'download.sign-url',
                    extra: { id, encrypted: metadata.encrypted },
                    level: 'warning',
                });
                return {
                    useSignedUrl: false,
                    dl: metadata.dl,
                    dlimit: metadata.dlimit,
                };
            }

            return {
                useSignedUrl: true,
                url: signedUrl,
                dl: metadata.dl,
                dlimit: metadata.dlimit,
            };
        },
        {
            detail: {
                tags: ['Download'],
                summary: 'Get pre-signed download URL',
                description:
                    'Returns a pre-signed S3 download URL. Requires authentication (Authorization header) for encrypted files.',
            },
            response: {
                200: t.Object({
                    useSignedUrl: t.Boolean(),
                    url: t.Optional(t.String()),
                    dl: t.Number(),
                    dlimit: t.Number(),
                }),
                401: t.Object({ error: t.String() }),
                404: t.Object({ error: t.String() }),
            },
        },
    )

    // Stream download (fallback when pre-signed URLs not available)
    .get(
        '/download/:id',
        async ({ params, headers, set }) => {
            const { id } = params;
            const authHeader = headers.authorization || null;

            const metadata = await storage.getMetadata(id);
            if (!metadata) {
                set.status = 404;
                return { error: 'File not found' };
            }

            // Verify authentication for encrypted files
            if (metadata.encrypted) {
                const { valid, nonce } = await verifyAuth(id, authHeader);
                set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

                if (!valid) {
                    set.status = 401;
                    return { error: 'Authentication required' };
                }
            }

            if (metadata.dl >= metadata.dlimit) {
                set.status = 410;
                return { error: 'Download limit reached' };
            }

            const stream = await storage.getStream(id);
            if (!stream) {
                set.status = 404;
                return { error: 'File not found' };
            }

            set.headers['Content-Type'] = 'application/octet-stream';
            const contentLength = streamContentLength(stream);
            if (contentLength !== undefined) {
                set.headers['Content-Length'] = String(contentLength);
            }
            return stream;
        },
        {
            detail: {
                tags: ['Download'],
                summary: 'Stream download',
                description:
                    'Streams the file directly from S3. Fallback when pre-signed URLs are not available. Requires authentication for encrypted files.',
            },
        },
    )

    // Blob download (alternative endpoint)
    .get(
        '/download/blob/:id',
        async ({ params, headers, set }) => {
            const { id } = params;
            const authHeader = headers.authorization || null;

            const metadata = await storage.getMetadata(id);
            if (!metadata) {
                set.status = 404;
                return { error: 'File not found' };
            }

            if (metadata.encrypted) {
                const { valid, nonce } = await verifyAuth(id, authHeader);
                set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

                if (!valid) {
                    set.status = 401;
                    return { error: 'Authentication required' };
                }
            }

            if (metadata.dl >= metadata.dlimit) {
                set.status = 410;
                return { error: 'Download limit reached' };
            }

            const stream = await storage.getStream(id);
            if (!stream) {
                set.status = 404;
                return { error: 'File not found' };
            }

            set.headers['Content-Type'] = 'application/octet-stream';
            const contentLength = streamContentLength(stream);
            if (contentLength !== undefined) {
                set.headers['Content-Length'] = String(contentLength);
            }
            return stream;
        },
        {
            detail: {
                tags: ['Download'],
                summary: 'Blob download',
                description:
                    'Alternative download endpoint that streams the file as an octet-stream blob. Requires authentication for encrypted files.',
            },
        },
    )

    // Report download complete (increments counter, may delete file)
    .post(
        '/download/complete/:id',
        async ({ params, headers, set }) => {
            const { id } = params;
            const authHeader = headers.authorization || null;

            const metadata = await storage.getMetadata(id);
            if (!metadata) {
                set.status = 404;
                return { error: 'File not found' };
            }

            // Verify authentication for encrypted files
            if (metadata.encrypted) {
                const { valid, nonce } = await verifyAuth(id, authHeader);
                set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

                if (!valid) {
                    set.status = 401;
                    return { error: 'Authentication required' };
                }
            }

            // Increment download counter
            const newDl = await storage.incrementDownloadCount(id);

            // Re-read the limit before destroying anything: the owner may have
            // raised dlimit via /params since the snapshot above, and deleting
            // against the stale value kills a file that is still within its
            // (just-extended) limit. Mirrors the fire-time re-check that
            // scheduleLimitDeletion already performs.
            const dlimit = await readCurrentDownloadLimit(id, metadata.dlimit);

            // Check if download limit reached
            if (newDl >= dlimit) {
                logger.info({ id, dl: newDl, dlimit }, 'Download limit reached, deleting file');
                try {
                    await storage.del(id);
                } catch (e) {
                    captureError(e, {
                        operation: 'download.delete-on-limit',
                        extra: { id, dl: newDl, dlimit },
                    });
                }
                // Backstop: if the delete failed, cap the metadata TTL so
                // consumed metadata cannot outlive the failure by days
                storage.redis.expire(id, 300).catch(() => {
                    // Non-critical — natural TTL still applies
                });
                return { deleted: true, dl: newDl, dlimit };
            }

            return { deleted: false, dl: newDl, dlimit };
        },
        {
            detail: {
                tags: ['Download'],
                summary: 'Report download complete',
                description:
                    'Increments the download counter. Deletes the file if the download limit is reached. Requires authentication for encrypted files.',
            },
            response: {
                200: t.Object({
                    deleted: t.Boolean(),
                    dl: t.Number(),
                    dlimit: t.Number(),
                }),
                401: t.Object({ error: t.String() }),
                404: t.Object({ error: t.String() }),
            },
        },
    )

    // Get file metadata
    .get(
        '/metadata/:id',
        async ({ params, headers, set }) => {
            const { id } = params;
            const authHeader = headers.authorization || null;

            logger.info({ id }, 'Metadata request received');

            const metadata = await storage.getMetadata(id);
            if (!metadata) {
                logger.warn({ id }, 'File not found');
                set.status = 404;
                return { error: 'File not found' };
            }

            logger.debug(
                {
                    id,
                    encrypted: metadata.encrypted,
                    hasMetadata: !!metadata.metadata,
                    metadataLength: metadata.metadata?.length,
                    metadataPreview: metadata.metadata?.substring(0, 100),
                },
                'File metadata loaded',
            );

            // Verify authentication for encrypted files
            if (metadata.encrypted) {
                const { valid, nonce } = await verifyAuth(id, authHeader);
                set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

                if (!valid) {
                    logger.warn({ id }, 'Authentication failed');
                    set.status = 401;
                    return { error: 'Authentication required' };
                }
                logger.debug({ id }, 'Authentication successful');
            }

            const ttl = await storage.getTTL(id);

            const response = {
                metadata: metadata.metadata || '',
                ttl,
                encrypted: metadata.encrypted,
            };

            logger.info(
                {
                    id,
                    ttl,
                    encrypted: metadata.encrypted,
                    responseMetadataLength: response.metadata.length,
                },
                'Returning metadata response',
            );

            return response;
        },
        {
            detail: {
                tags: ['Download'],
                summary: 'Get file metadata',
                description:
                    'Returns file metadata including encryption status and TTL. Requires authentication for encrypted files.',
            },
            response: {
                200: t.Object({
                    metadata: t.String(),
                    ttl: t.Number(),
                    encrypted: t.Boolean(),
                }),
                401: t.Object({ error: t.String() }),
                404: t.Object({ error: t.String() }),
            },
        },
    )

    // Check if file exists
    .get(
        '/exists/:id',
        async ({ params }) => {
            const { id } = params;
            const exists = await storage.exists(id);
            return { exists };
        },
        {
            detail: {
                tags: ['Download'],
                summary: 'Check file existence',
                description: 'Checks whether a file exists in the system by its ID.',
            },
            response: {
                200: t.Object({
                    exists: t.Boolean(),
                }),
            },
        },
    )

    // Check if file exists on legacy system
    .get(
        '/download/legacy/:id',
        async ({ params }) => {
            const { id } = params;
            try {
                const response = await fetch(`https://legacy.send.fm/api/exists/${id}`);
                if (response.status < 400) {
                    return { redirect: `https://legacy.send.fm/download/${id}` };
                }
                return { redirect: null };
            } catch {
                return { redirect: null };
            }
        },
        {
            detail: {
                tags: ['Download'],
                summary: 'Check legacy system',
                description:
                    'Checks if a file exists on the legacy system and returns a redirect URL if found.',
            },
            response: {
                200: t.Object({
                    redirect: t.Union([t.String(), t.Null()]),
                }),
            },
        },
    )

    // Delete file (owner only)
    .post(
        '/delete/:id',
        async ({ params, body, set }) => {
            const { id } = params;
            const { owner_token } = body;

            if (!(await verifyOwner(id, owner_token))) {
                set.status = 401;
                return { error: 'Invalid owner token' };
            }

            await storage.del(id);
            return { success: true };
        },
        {
            detail: {
                tags: ['File Management'],
                summary: 'Delete file',
                description:
                    'Permanently deletes a file from S3 and removes its metadata from Redis. Requires the owner token.',
            },
            body: t.Object({
                owner_token: t.String(),
            }),
            response: {
                200: t.Object({ success: t.Boolean() }),
                401: t.Object({ error: t.String() }),
            },
        },
    )

    // Update file parameters (owner only)
    .post(
        '/params/:id',
        async ({ params, body, set }) => {
            const { id } = params;
            const { owner_token, dlimit } = body;

            if (!(await verifyOwner(id, owner_token))) {
                set.status = 401;
                return { error: 'Invalid owner token' };
            }

            if (dlimit !== undefined) {
                // Clamp exactly as the upload route does at creation — an
                // unbounded dlimit makes the `dl >= dlimit` gate unreachable
                // (unlimited egress) and a non-integer corrupts the Redis
                // round-trip
                const nextLimit = clampDownloadLimit(dlimit);
                await storage.setField(id, 'dlimit', nextLimit.toString());

                // If the limit-reached TTL backstop was applied and this raise
                // makes the file downloadable again, restore the original expiry
                const metadata = await storage.getMetadata(id);
                if (metadata && metadata.dl < nextLimit) {
                    const expiresAt = await storage.getField(id, 'expiresAt');
                    if (expiresAt) {
                        const remaining = parseInt(expiresAt, 10) - Math.floor(Date.now() / 1000);
                        if (remaining > 0) {
                            await storage.redis.expire(id, remaining);
                        }
                        await storage.redis.hDel(id, 'expiresAt');
                    }
                }
            }

            return { success: true };
        },
        {
            detail: {
                tags: ['File Management'],
                summary: 'Update file parameters',
                description:
                    'Updates file parameters such as download limit. Requires the owner token.',
            },
            body: t.Object({
                owner_token: t.String(),
                dlimit: t.Optional(t.Integer({ minimum: 1 })),
            }),
            response: {
                200: t.Object({ success: t.Boolean() }),
                401: t.Object({ error: t.String() }),
            },
        },
    )

    // Get file info (owner only)
    .post(
        '/info/:id',
        async ({ params, body, set }) => {
            const { id } = params;
            const { owner_token } = body;

            if (!(await verifyOwner(id, owner_token))) {
                set.status = 401;
                return { error: 'Invalid owner token' };
            }

            const metadata = await storage.getMetadata(id);
            if (!metadata) {
                set.status = 404;
                return { error: 'File not found' };
            }

            const ttl = await storage.getTTL(id);

            return {
                dl: metadata.dl,
                dlimit: metadata.dlimit,
                ttl,
            };
        },
        {
            detail: {
                tags: ['File Management'],
                summary: 'Get file info (owner)',
                description:
                    'Returns file download count, download limit, and TTL. Requires the owner token.',
            },
            body: t.Object({
                owner_token: t.String(),
            }),
            response: {
                200: t.Object({
                    dl: t.Number(),
                    dlimit: t.Number(),
                    ttl: t.Number(),
                }),
                401: t.Object({ error: t.String() }),
                404: t.Object({ error: t.String() }),
            },
        },
    )

    // Set password (owner only)
    .post(
        '/password/:id',
        async ({ params, body, set }) => {
            const { id } = params;
            const { owner_token, auth } = body;

            if (!(await verifyOwner(id, owner_token))) {
                set.status = 401;
                return { error: 'Invalid owner token' };
            }

            const metadata = await storage.getMetadata(id);
            if (!metadata?.encrypted) {
                set.status = 400;
                return { error: 'Password protection is only supported for encrypted files' };
            }

            await storage.setField(id, 'auth', auth);

            return { success: true };
        },
        {
            detail: {
                tags: ['File Management'],
                summary: 'Set file password',
                description:
                    'Sets or updates the authentication password for a file. Only supported for encrypted files — unencrypted files skip auth entirely, so a password would never be enforced. Requires the owner token.',
            },
            body: t.Object({
                owner_token: t.String(),
                auth: t.String(),
            }),
            response: {
                200: t.Object({ success: t.Boolean() }),
                400: t.Object({ error: t.String() }),
                401: t.Object({ error: t.String() }),
            },
        },
    );
