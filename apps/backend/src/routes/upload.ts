import { randomBytes } from 'node:crypto';
import { UPLOAD_LIMITS } from '@bolter/shared';
import { Elysia, t } from 'elysia';
import { config, deriveBaseUrl } from '../config';
import { captureError } from '../lib/sentry';
import { uploadLogger as logger } from '../logger';
import { type CompletedPart, storage } from '../storage';

const MULTIPART_THRESHOLD = UPLOAD_LIMITS.MULTIPART_THRESHOLD;
const DEFAULT_PART_SIZE = UPLOAD_LIMITS.DEFAULT_PART_SIZE;
const MAX_PARTS = UPLOAD_LIMITS.MAX_PARTS;
const MAX_PART_SIZE = UPLOAD_LIMITS.MAX_PART_SIZE;
const MIN_PART_SIZE = UPLOAD_LIMITS.MIN_PART_SIZE;

interface PartInfo {
    partNumber: number;
    url: string;
    minSize: number;
    maxSize: number;
}

function calculateOptimalPartSize(
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

    // Ensure the last part won't be smaller than MIN_PART_SIZE (5MB)
    // This prevents R2 EntityTooSmall errors when compressed/encrypted size
    // lands just above a multiple of partSize
    if (numParts > 1) {
        const lastPartSize = fileSize - (numParts - 1) * partSize;
        if (lastPartSize > 0 && lastPartSize < MIN_PART_SIZE) {
            numParts = numParts - 1;
            partSize = Math.ceil(fileSize / numParts);
            // Align to MB boundary
            partSize = Math.ceil(partSize / (1024 * 1024)) * (1024 * 1024);
            numParts = Math.ceil(fileSize / partSize);
        }
    }

    return { partSize, numParts };
}

// Pre-signed URL expiration: 7 days (max allowed by S3/R2)
const URL_EXPIRATION_SECONDS = 7 * 24 * 60 * 60; // 604800

export const uploadRoutes = new Elysia()
    // Get upload URL(s)
    .post(
        '/upload/url',
        async ({ body, request }) => {
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

            if (!fileSize || fileSize < 0) {
                logger.warn({ requestId, fileSize }, 'Invalid file size');
                return { error: 'Invalid file size' };
            }

            if (fileSize > config.maxFileSize) {
                logger.warn(
                    { requestId, fileSize, maxFileSize: config.maxFileSize },
                    'File size exceeds maximum',
                );
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
                    testUrlPreview: testUploadUrl ? `${testUploadUrl.substring(0, 100)}...` : null,
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

            // Generate file ID and owner token
            const id = randomBytes(8).toString('hex');
            const owner = randomBytes(10).toString('hex');

            logger.info({ requestId, id, owner }, 'Generated file ID and owner token');

            // Calculate expiration
            const expireSeconds = Math.min(
                timeLimit || config.defaultExpireSeconds,
                config.maxExpireSeconds,
            );
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

            await storage.setField(id, 'prefix', prefix.toString());
            await storage.setField(id, 'owner', owner);
            await storage.setField(id, 'encrypted', encrypted ? 'true' : 'false');
            await storage.setField(id, 'dl', '0');
            await storage.setField(id, 'dlimit', (dlimit || config.defaultDownloads).toString());
            await storage.setField(id, 'fileSize', fileSize.toString());
            await storage.redis.expire(id, expireSeconds);

            const redisDuration = Date.now() - redisStartTime;
            logger.info({ requestId, id, redisDuration }, 'Initial metadata stored in Redis');

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

                // Create multipart upload
                logger.info({ requestId, id }, 'Creating multipart upload');
                const multipartStartTime = Date.now();
                const uploadId = await storage.createMultipartUpload(id, objectExpires);
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

                for (let batchStart = 1; batchStart <= numParts; batchStart += BATCH_SIZE) {
                    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, numParts);
                    const batchPromises: Promise<PartInfo>[] = [];

                    logger.debug({ requestId, id, batchStart, batchEnd }, 'Processing URL batch');

                    for (let i = batchStart; i <= batchEnd; i++) {
                        batchPromises.push(
                            storage
                                .getSignedMultipartUploadUrl(
                                    id,
                                    uploadId,
                                    i,
                                    URL_EXPIRATION_SECONDS,
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

                // Store multipart upload info
                await storage.setField(id, 'uploadId', uploadId);
                await storage.setField(id, 'multipart', 'true');
                await storage.setField(id, 'numParts', numParts.toString());
                await storage.setField(id, 'partSize', partSize.toString());

                const response = {
                    useSignedUrl: true,
                    multipart: true,
                    id,
                    owner,
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
                        firstPartUrl: `${parts[0]?.url.substring(0, 100)}...`,
                    },
                    'Multipart upload response ready',
                );

                return response;
            } else {
                // Single part upload
                logger.info({ requestId, id }, 'Generating single upload URL');
                const singleUrlStartTime = Date.now();
                const uploadUrl = await storage.getSignedUploadUrl(
                    id,
                    new Date(Date.now() + URL_EXPIRATION_SECONDS * 1000),
                );
                const singleUrlDuration = Date.now() - singleUrlStartTime;

                logger.info(
                    {
                        requestId,
                        id,
                        singleUrlDuration,
                        uploadUrl: uploadUrl,
                        urlLength: uploadUrl?.length,
                    },
                    'Single upload URL generated',
                );

                const response = {
                    useSignedUrl: true,
                    multipart: false,
                    id,
                    owner,
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
                    'Generates pre-signed S3 upload URLs. Returns a single URL for small files or multipart upload URLs for files exceeding the multipart threshold.',
            },
            body: t.Object({
                fileSize: t.Number(),
                encrypted: t.Optional(t.Boolean()),
                timeLimit: t.Optional(t.Number()),
                dlimit: t.Optional(t.Number()),
                preferredPartSize: t.Optional(t.Number()),
            }),
            response: {
                200: t.Object({
                    useSignedUrl: t.Optional(t.Boolean()),
                    multipart: t.Optional(t.Boolean()),
                    id: t.Optional(t.String()),
                    owner: t.Optional(t.String()),
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
            },
        },
    )

    // Complete upload
    .post(
        '/upload/complete',
        async ({ body, request }) => {
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
                return { error: 'Missing file ID' };
            }

            logger.debug({ requestId, id }, 'Fetching file metadata');
            const fileInfo = await storage.getMetadata(id);

            if (!fileInfo) {
                logger.warn({ requestId, id }, 'File not found in Redis');
                return { error: 'File not found', status: 404 };
            }

            logger.debug({ requestId, id, fileInfo }, 'File metadata retrieved');

            const isMultipart = fileInfo.multipart;

            if (isMultipart) {
                logger.info(
                    { requestId, id, isMultipart: true },
                    'Processing multipart upload completion',
                );

                if (!parts || !Array.isArray(parts)) {
                    logger.warn({ requestId, id }, 'Missing parts data for multipart upload');
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
                    return {
                        error: `Too many parts: got ${parts.length}, expected at most ${expectedParts}`,
                    };
                }

                const uploadId = fileInfo.uploadId;
                if (!uploadId) {
                    logger.error({ requestId, id }, 'Upload ID not found in metadata');
                    return { error: 'Upload ID not found' };
                }

                // Sort and convert parts to AWS format
                const sortedParts: CompletedPart[] = parts
                    .sort((a, b) => a.PartNumber - b.PartNumber)
                    .map((p) => ({
                        PartNumber: p.PartNumber,
                        ETag: p.ETag,
                    }));

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
                    await storage.completeMultipartUpload(id, uploadId, sortedParts);
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
                    captureError(e, {
                        operation: 'upload.multipart-complete',
                        extra: {
                            requestId,
                            id,
                            uploadId,
                            partsReceived: parts.length,
                            partsAllocated: expectedParts,
                            errorCode: err.code,
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
                            errorCode: err.code,
                        },
                        'Failed to complete multipart upload',
                    );

                    // Provide specific error messages
                    if (err.code === 'NoSuchUpload') {
                        return { error: 'Upload not found or expired', status: 404 };
                    } else if (err.code === 'InvalidPart' || err.code === 'InvalidPartOrder') {
                        return { error: 'Invalid upload parts', status: 400 };
                    } else if (err.code === 'EntityTooSmall') {
                        return { error: 'Upload parts too small', status: 400 };
                    }

                    throw e;
                }

                // Clean up multipart metadata
                await storage.redis.hDel(id, 'uploadId', 'multipart', 'numParts');
                logger.debug({ requestId, id }, 'Cleaned up multipart metadata');
            }

            // Store final metadata
            if (metadata && typeof metadata === 'string') {
                await storage.setField(id, 'metadata', metadata);
                logger.debug(
                    { requestId, id, metadataLength: metadata.length },
                    'Stored file metadata',
                );
            }

            // Set auth based on encryption
            if (fileInfo.encrypted) {
                if (!authKey || typeof authKey !== 'string') {
                    logger.warn(
                        { requestId, id },
                        'Missing or invalid auth key for encrypted file',
                    );
                    return { error: 'Missing or invalid auth key for encrypted file' };
                }
                await storage.setField(id, 'auth', authKey);
                const nonce = randomBytes(16).toString('base64');
                await storage.setField(id, 'nonce', nonce);
                logger.debug({ requestId, id }, 'Stored auth key and nonce for encrypted file');
            } else {
                await storage.setField(id, 'auth', 'unencrypted');
                await storage.setField(id, 'nonce', '');
                logger.debug({ requestId, id }, 'Set unencrypted auth');
            }

            // Update file size if provided
            if (actualSize) {
                await storage.setField(id, 'size', actualSize.toString());
                logger.debug({ requestId, id, actualSize }, 'Updated actual file size');
            }

            logger.info(
                {
                    requestId,
                    id,
                    multipart: isMultipart,
                    encrypted: fileInfo.encrypted,
                },
                'Upload completed successfully',
            );

            return {
                success: true,
                id,
                url: `${deriveBaseUrl(request)}/download/${id}#${fileInfo.owner}`,
            };
        },
        {
            detail: {
                tags: ['Upload'],
                summary: 'Complete file upload',
                description:
                    'Finalizes an upload by completing the S3 multipart upload (if applicable), storing file metadata, and setting authentication.',
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
                    error: t.Optional(t.String()),
                    status: t.Optional(t.Number()),
                }),
            },
        },
    )

    // Abort multipart upload
    .post(
        '/upload/abort/:id',
        async ({ params, body }) => {
            const { id } = params;
            const { uploadId } = body;
            const requestId = randomBytes(4).toString('hex');

            logger.info({ requestId, id, uploadId }, 'Abort upload request received');

            if (!uploadId) {
                logger.warn({ requestId, id }, 'Missing upload ID');
                return { error: 'Missing upload ID' };
            }

            try {
                await storage.abortMultipartUpload(id, uploadId);
                await storage.redis.del(id);
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
                    'Aborts an in-progress multipart upload, cleaning up uploaded parts from S3 and removing metadata from Redis.',
            },
            body: t.Object({
                uploadId: t.String(),
            }),
            response: {
                200: t.Object({
                    success: t.Optional(t.Boolean()),
                    error: t.Optional(t.String()),
                }),
            },
        },
    )

    // Resume multipart upload — generate pre-signed URLs for remaining parts
    .post(
        '/upload/multipart/:id/resume',
        async ({ params, body, set }) => {
            const { id } = params;
            const { uploadId, completedPartNumbers } = body;
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
                            .getSignedMultipartUploadUrl(id, uploadId, i, URL_EXPIRATION_SECONDS)
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
                    'Generates new pre-signed URLs for remaining parts of an interrupted multipart upload. Skips already-uploaded parts.',
            },
            body: t.Object({
                uploadId: t.String(),
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
                404: t.Object({ error: t.String() }),
            },
        },
    )

    // Speed test — creates a multipart upload with 5 pre-signed part URLs.
    // The client uploads 5x100MB parts concurrently to measure real throughput.
    .post(
        '/upload/speedtest',
        async () => {
            const SPEEDTEST_NUM_PARTS = 5;
            const testId = `__speedtest__${randomBytes(8).toString('hex')}`;

            try {
                const uploadId = await storage.createMultipartUpload(testId);
                if (!uploadId) {
                    return { error: 'Failed to create speed test upload' };
                }

                const parts = await Promise.all(
                    Array.from({ length: SPEEDTEST_NUM_PARTS }, (_, i) =>
                        storage
                            .getSignedMultipartUploadUrl(testId, uploadId, i + 1, 60)
                            .then((url) => ({ partNumber: i + 1, url })),
                    ),
                );

                logger.info(
                    { testId, uploadId, numParts: SPEEDTEST_NUM_PARTS },
                    'Speed test URLs generated',
                );
                return { testId, uploadId, parts };
            } catch (e) {
                logger.warn({ testId, error: e }, 'Speed test setup failed');
                return { error: 'Speed test setup failed' };
            }
        },
        {
            detail: {
                tags: ['Speed Test'],
                summary: 'Start upload speed test',
                description:
                    'Creates a temporary multipart upload with 5 pre-signed part URLs for measuring upload throughput.',
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
            },
        },
    )

    // Clean up speed test object after the test completes
    .post(
        '/upload/speedtest/cleanup',
        async ({ body }) => {
            const { testId, uploadId } = body;
            try {
                // Abort the multipart upload (cleans up parts from S3)
                if (uploadId) {
                    await storage.abortMultipartUpload(testId, uploadId);
                }
                logger.info({ testId }, 'Speed test cleaned up');
            } catch (e) {
                logger.warn({ testId, error: e }, 'Failed to clean up speed test');
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
            },
        },
    );
