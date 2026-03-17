import { Elysia, t } from 'elysia';
import { captureError } from '../lib/sentry';
import { downloadLogger as logger } from '../logger';
import { verifyAuth, verifyOwner } from '../middleware/auth';
import { storage } from '../storage';

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

            // Increment counter before redirect
            const newDl = await storage.incrementDownloadCount(id);

            // Check if limit exceeded after increment
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
                setTimeout(() => storage.del(id), 300000); // 5 min delay
            }

            // Get signed URL with filename for Content-Disposition
            const signedUrl = await storage.getSignedDownloadUrl(id, filename);
            if (!signedUrl) {
                captureError(new Error('Failed to generate signed download URL'), {
                    operation: 'download.sign-url',
                    extra: { id, filename },
                });
                set.status = 500;
                return { error: 'Failed to generate download URL' };
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

            const stream = await storage.getStream(id);
            if (!stream) {
                set.status = 404;
                return { error: 'File not found' };
            }

            set.headers['Content-Type'] = 'application/octet-stream';
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

            const stream = await storage.getStream(id);
            if (!stream) {
                set.status = 404;
                return { error: 'File not found' };
            }

            set.headers['Content-Type'] = 'application/octet-stream';
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

            // Check if download limit reached
            if (newDl >= metadata.dlimit) {
                console.log('Download limit reached, deleting file:', {
                    id,
                    dl: newDl,
                    dlimit: metadata.dlimit,
                });
                try {
                    await storage.del(id);
                } catch (e) {
                    captureError(e, {
                        operation: 'download.delete-on-limit',
                        extra: { id, dl: newDl, dlimit: metadata.dlimit },
                    });
                }
                return { deleted: true, dl: newDl, dlimit: metadata.dlimit };
            }

            return { deleted: false, dl: newDl, dlimit: metadata.dlimit };
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
                await storage.setField(id, 'dlimit', dlimit.toString());
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
                dlimit: t.Optional(t.Number()),
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

            await storage.setField(id, 'auth', auth);

            return { success: true };
        },
        {
            detail: {
                tags: ['File Management'],
                summary: 'Set file password',
                description:
                    'Sets or updates the authentication password for a file. Requires the owner token.',
            },
            body: t.Object({
                owner_token: t.String(),
                auth: t.String(),
            }),
            response: {
                200: t.Object({ success: t.Boolean() }),
                401: t.Object({ error: t.String() }),
            },
        },
    );
