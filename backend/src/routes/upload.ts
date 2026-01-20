import { Elysia, t } from 'elysia';
import { randomBytes } from 'crypto';
import { storage, type CompletedPart } from '../storage';
import { config, deriveBaseUrl } from '../config';
import { uploadLogger as logger } from '../logger';
import { UPLOAD_LIMITS } from '@bolter/shared';

const MULTIPART_THRESHOLD = UPLOAD_LIMITS.MULTIPART_THRESHOLD;
const DEFAULT_PART_SIZE = UPLOAD_LIMITS.DEFAULT_PART_SIZE;
const MAX_PARTS = UPLOAD_LIMITS.MAX_PARTS;
const MAX_PART_SIZE = UPLOAD_LIMITS.MAX_PART_SIZE;

interface PartInfo {
  partNumber: number;
  url: string;
  minSize: number;
  maxSize: number;
}

function calculateOptimalPartSize(fileSize: number): { partSize: number; numParts: number } {
  let partSize = DEFAULT_PART_SIZE;
  let numParts = Math.ceil(fileSize / partSize);

  if (numParts > MAX_PARTS) {
    partSize = Math.ceil(fileSize / MAX_PARTS);

    if (partSize > MAX_PART_SIZE) {
      throw new Error('File too large: would require parts larger than 5GB limit');
    }

    partSize = Math.ceil(partSize / (1024 * 1024)) * (1024 * 1024);
    numParts = Math.ceil(fileSize / partSize);
  }

  return { partSize, numParts };
}

export const uploadRoutes = new Elysia()
  // Get upload URL(s)
  .post('/upload/url', async ({ body, request }) => {
    const { fileSize, encrypted, timeLimit, dlimit } = body;
    const requestId = randomBytes(4).toString('hex');

    logger.info({
      requestId,
      fileSize,
      fileSizeMB: Math.round(fileSize / (1024 * 1024) * 100) / 100,
      encrypted,
      timeLimit,
      dlimit,
    }, 'Upload URL request received');

    if (!fileSize || fileSize < 0) {
      logger.warn({ requestId, fileSize }, 'Invalid file size');
      return { error: 'Invalid file size' };
    }

    if (fileSize > config.maxFileSize) {
      logger.warn({ requestId, fileSize, maxFileSize: config.maxFileSize }, 'File size exceeds maximum');
      return { error: `File size exceeds maximum of ${config.maxFileSize} bytes` };
    }

    // Check if we can use pre-signed URLs
    logger.debug({ requestId }, 'Testing pre-signed URL generation');
    const testStartTime = Date.now();
    const testUploadUrl = await storage.getSignedUploadUrl('test');
    const testDuration = Date.now() - testStartTime;

    logger.info({
      requestId,
      testDuration,
      testSuccess: !!testUploadUrl,
      testUrlPreview: testUploadUrl ? testUploadUrl.substring(0, 100) + '...' : null,
    }, 'Pre-signed URL test completed');

    if (!testUploadUrl) {
      logger.error({ requestId }, 'Pre-signed URL test failed, falling back to direct upload');
      return { useSignedUrl: false };
    }

    // Generate file ID and owner token
    const id = randomBytes(8).toString('hex');
    const owner = randomBytes(10).toString('hex');

    logger.info({ requestId, id, owner }, 'Generated file ID and owner token');

    // Calculate expiration
    const expireSeconds = Math.min(
      timeLimit || config.defaultExpireSeconds,
      config.maxExpireSeconds
    );
    const prefix = Math.max(Math.floor(expireSeconds / 86400), 1);

    logger.debug({ requestId, id, expireSeconds, prefix }, 'Calculated expiration');

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
    logger.info({ requestId, id, useMultipart, threshold: MULTIPART_THRESHOLD }, 'Determined upload type');

    if (useMultipart) {
      const { partSize, numParts } = calculateOptimalPartSize(fileSize);

      logger.info({
        requestId,
        id,
        fileSize,
        partSize,
        numParts,
        fileSizeGB: Math.round((fileSize / (1024 * 1024 * 1024)) * 100) / 100,
        partSizeMB: Math.round(partSize / (1024 * 1024)),
      }, 'Multipart upload plan calculated');

      // Create multipart upload
      logger.info({ requestId, id }, 'Creating multipart upload');
      const multipartStartTime = Date.now();
      const uploadId = await storage.createMultipartUpload(id);
      const multipartDuration = Date.now() - multipartStartTime;

      if (!uploadId) {
        logger.error({ requestId, id, multipartDuration }, 'Failed to create multipart upload');
        return { useSignedUrl: false };
      }

      logger.info({ requestId, id, uploadId, multipartDuration }, 'Multipart upload created');

      // Generate URLs in parallel batches
      const BATCH_SIZE = 100;
      const parts: PartInfo[] = [];
      const urlGenStartTime = Date.now();

      logger.info({ requestId, id, numParts, batchSize: BATCH_SIZE }, 'Starting URL generation');

      for (let batchStart = 1; batchStart <= numParts; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, numParts);
        const batchPromises: Promise<PartInfo>[] = [];

        logger.debug({ requestId, id, batchStart, batchEnd }, 'Processing URL batch');

        for (let i = batchStart; i <= batchEnd; i++) {
          batchPromises.push(
            storage.getSignedMultipartUploadUrl(id, uploadId, i).then((url) => ({
              partNumber: i,
              url,
              minSize: i === numParts ? 0 : partSize,
              maxSize: partSize,
            }))
          );
        }

        const batchParts = await Promise.all(batchPromises);
        parts.push(...batchParts);

        if (numParts > 100 || batchStart === 1) {
          logger.info({
            requestId,
            id,
            generated: parts.length,
            total: numParts,
            percentage: Math.round((parts.length / numParts) * 100),
            elapsed: Date.now() - urlGenStartTime,
          }, 'URL generation progress');
        }
      }

      const urlGenDuration = Date.now() - urlGenStartTime;
      logger.info({
        requestId,
        id,
        numParts,
        urlGenDuration,
        avgTimePerUrl: Math.round(urlGenDuration / numParts * 100) / 100,
      }, 'All upload URLs generated');

      // Store multipart upload info
      await storage.setField(id, 'uploadId', uploadId);
      await storage.setField(id, 'multipart', 'true');
      await storage.setField(id, 'numParts', numParts.toString());

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

      logger.info({
        requestId,
        id,
        uploadId,
        numParts,
        partSize,
        totalTime: Date.now() - testStartTime,
        firstPartUrl: parts[0]?.url.substring(0, 100) + '...',
      }, 'Multipart upload response ready');

      return response;
    } else {
      // Single part upload
      logger.info({ requestId, id }, 'Generating single upload URL');
      const singleUrlStartTime = Date.now();
      const uploadUrl = await storage.getSignedUploadUrl(id);
      const singleUrlDuration = Date.now() - singleUrlStartTime;

      logger.info({
        requestId,
        id,
        singleUrlDuration,
        uploadUrl: uploadUrl,
        urlLength: uploadUrl?.length,
      }, 'Single upload URL generated');

      const response = {
        useSignedUrl: true,
        multipart: false,
        id,
        owner,
        url: uploadUrl,
        completeUrl: `${deriveBaseUrl(request)}/download/${id}#${owner}`,
      };

      logger.info({
        requestId,
        id,
        totalTime: Date.now() - testStartTime,
      }, 'Single upload response ready');

      return response;
    }
  }, {
    body: t.Object({
      fileSize: t.Number(),
      encrypted: t.Optional(t.Boolean()),
      timeLimit: t.Optional(t.Number()),
      dlimit: t.Optional(t.Number()),
    }),
  })

  // Complete upload
  .post('/upload/complete', async ({ body, request }) => {
    const { id, metadata, authKey, actualSize, parts } = body;
    const requestId = randomBytes(4).toString('hex');

    logger.info({
      requestId,
      id,
      hasMetadata: !!metadata,
      hasAuthKey: !!authKey,
      actualSize,
      partsCount: parts?.length,
    }, 'Upload complete request received');

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
      logger.info({ requestId, id, isMultipart: true }, 'Processing multipart upload completion');

      if (!parts || !Array.isArray(parts)) {
        logger.warn({ requestId, id }, 'Missing parts data for multipart upload');
        return { error: 'Missing parts data' };
      }

      // Allow completion with fewer parts than allocated (stream ended early)
      const expectedParts = fileInfo.numParts || 0;
      if (parts.length > expectedParts) {
        logger.warn({
          requestId,
          id,
          receivedParts: parts.length,
          expectedParts,
        }, 'Too many parts received');
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
        .sort((a: any, b: any) => a.PartNumber - b.PartNumber)
        .map((p: any) => ({
          PartNumber: p.PartNumber,
          ETag: p.ETag,
        }));

      logger.info({
        requestId,
        id,
        uploadId,
        partsReceived: parts.length,
        partsAllocated: expectedParts,
        firstPart: sortedParts[0],
        lastPart: sortedParts[sortedParts.length - 1],
      }, 'Completing multipart upload');

      try {
        const completeStartTime = Date.now();
        await storage.completeMultipartUpload(id, uploadId, sortedParts);
        const completeDuration = Date.now() - completeStartTime;

        logger.info({
          requestId,
          id,
          uploadId,
          completeDuration,
        }, 'Multipart upload completed successfully');
      } catch (e: any) {
        logger.error({
          requestId,
          id,
          uploadId,
          error: e,
          errorName: e.name,
          errorMessage: e.message,
          errorCode: e.code,
        }, 'Failed to complete multipart upload');

        // Provide specific error messages
        if (e.code === 'NoSuchUpload') {
          return { error: 'Upload not found or expired', status: 404 };
        } else if (e.code === 'InvalidPart' || e.code === 'InvalidPartOrder') {
          return { error: 'Invalid upload parts', status: 400 };
        } else if (e.code === 'EntityTooSmall') {
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
      logger.debug({ requestId, id, metadataLength: metadata.length }, 'Stored file metadata');
    }

    // Set auth based on encryption
    if (fileInfo.encrypted) {
      if (!authKey || typeof authKey !== 'string') {
        logger.warn({ requestId, id }, 'Missing or invalid auth key for encrypted file');
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

    logger.info({
      requestId,
      id,
      multipart: isMultipart,
      encrypted: fileInfo.encrypted,
    }, 'Upload completed successfully');

    return {
      success: true,
      id,
      url: `${deriveBaseUrl(request)}/download/${id}#${fileInfo.owner}`,
    };
  }, {
    body: t.Object({
      id: t.String(),
      metadata: t.Optional(t.String()),
      authKey: t.Optional(t.String()),
      actualSize: t.Optional(t.Number()),
      parts: t.Optional(t.Array(t.Object({
        PartNumber: t.Number(),
        ETag: t.String(),
      }))),
    }),
  })

  // Abort multipart upload
  .post('/upload/abort/:id', async ({ params, body }) => {
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
      logger.error({ requestId, id, uploadId, error: e }, 'Failed to abort multipart upload');
      return { error: 'Failed to abort upload' };
    }
  }, {
    body: t.Object({
      uploadId: t.String(),
    }),
  });
