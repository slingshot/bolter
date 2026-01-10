import { Elysia, t } from 'elysia';
import { randomBytes } from 'crypto';
import { storage, type CompletedPart } from '../storage';
import { config, deriveBaseUrl } from '../config';

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
const DEFAULT_PART_SIZE = 50 * 1024 * 1024; // 50MB per part
const MAX_PARTS = 10000; // Cloudflare R2 limit
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5GB per part

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

export const uploadRoutes = new Elysia({ prefix: '/api' })
  // Get upload URL(s)
  .post('/upload/url', async ({ body, request }) => {
    const { fileSize, encrypted, timeLimit, dlimit } = body;

    if (!fileSize || fileSize < 0) {
      return { error: 'Invalid file size' };
    }

    if (fileSize > config.maxFileSize) {
      return { error: `File size exceeds maximum of ${config.maxFileSize} bytes` };
    }

    // Check if we can use pre-signed URLs
    const testUploadUrl = await storage.getSignedUploadUrl('test');
    if (!testUploadUrl) {
      return { useSignedUrl: false };
    }

    // Generate file ID and owner token
    const id = randomBytes(8).toString('hex');
    const owner = randomBytes(10).toString('hex');

    // Calculate expiration
    const expireSeconds = Math.min(
      timeLimit || config.defaultExpireSeconds,
      config.maxExpireSeconds
    );
    const prefix = Math.max(Math.floor(expireSeconds / 86400), 1);

    // Store initial metadata
    await storage.setField(id, 'prefix', prefix.toString());
    await storage.setField(id, 'owner', owner);
    await storage.setField(id, 'encrypted', encrypted ? 'true' : 'false');
    await storage.setField(id, 'dl', '0');
    await storage.setField(id, 'dlimit', (dlimit || config.defaultDownloads).toString());
    await storage.setField(id, 'fileSize', fileSize.toString());
    await storage.redis.expire(id, expireSeconds);

    const useMultipart = fileSize > MULTIPART_THRESHOLD;

    if (useMultipart) {
      const { partSize, numParts } = calculateOptimalPartSize(fileSize);

      console.log('Multipart upload plan:', {
        fileSize,
        partSize,
        numParts,
        fileSizeGB: Math.round((fileSize / (1024 * 1024 * 1024)) * 100) / 100,
        partSizeMB: Math.round(partSize / (1024 * 1024)),
      });

      // Create multipart upload
      const uploadId = await storage.createMultipartUpload(id);
      if (!uploadId) {
        return { useSignedUrl: false };
      }

      // Generate URLs in parallel batches
      const BATCH_SIZE = 100;
      const parts: PartInfo[] = [];

      for (let batchStart = 1; batchStart <= numParts; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, numParts);
        const batchPromises: Promise<PartInfo>[] = [];

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

        if (numParts > 1000) {
          console.log('Upload URL progress:', {
            generated: parts.length,
            total: numParts,
            percentage: Math.round((parts.length / numParts) * 100),
          });
        }
      }

      // Store multipart upload info
      await storage.setField(id, 'uploadId', uploadId);
      await storage.setField(id, 'multipart', 'true');
      await storage.setField(id, 'numParts', numParts.toString());

      return {
        useSignedUrl: true,
        multipart: true,
        id,
        owner,
        uploadId,
        parts,
        partSize,
        url: `${deriveBaseUrl(request)}/download/${id}#${owner}`,
      };
    } else {
      // Single part upload
      const uploadUrl = await storage.getSignedUploadUrl(id);

      return {
        useSignedUrl: true,
        multipart: false,
        id,
        owner,
        url: uploadUrl,
        completeUrl: `${deriveBaseUrl(request)}/download/${id}#${owner}`,
      };
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

    if (!id) {
      return { error: 'Missing file ID' };
    }

    const fileInfo = await storage.getMetadata(id);
    if (!fileInfo) {
      return { error: 'File not found', status: 404 };
    }

    const isMultipart = fileInfo.multipart;

    if (isMultipart) {
      if (!parts || !Array.isArray(parts)) {
        return { error: 'Missing parts data' };
      }

      // Allow completion with fewer parts than allocated (stream ended early)
      const expectedParts = fileInfo.numParts || 0;
      if (parts.length > expectedParts) {
        return {
          error: `Too many parts: got ${parts.length}, expected at most ${expectedParts}`,
        };
      }

      const uploadId = fileInfo.uploadId;
      if (!uploadId) {
        return { error: 'Upload ID not found' };
      }

      // Sort and convert parts to AWS format
      const sortedParts: CompletedPart[] = parts
        .sort((a: any, b: any) => a.PartNumber - b.PartNumber)
        .map((p: any) => ({
          PartNumber: p.PartNumber,
          ETag: p.ETag,
        }));

      console.log('Completing multipart upload:', {
        id,
        partsReceived: parts.length,
        partsAllocated: expectedParts,
      });

      try {
        await storage.completeMultipartUpload(id, uploadId, sortedParts);
      } catch (e: any) {
        console.error('Failed to complete multipart upload:', e);

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
    }

    // Store final metadata
    if (metadata && typeof metadata === 'string') {
      await storage.setField(id, 'metadata', metadata);
    }

    // Set auth based on encryption
    if (fileInfo.encrypted) {
      if (!authKey || typeof authKey !== 'string') {
        return { error: 'Missing or invalid auth key for encrypted file' };
      }
      await storage.setField(id, 'auth', authKey);
      const nonce = randomBytes(16).toString('base64');
      await storage.setField(id, 'nonce', nonce);
    } else {
      await storage.setField(id, 'auth', 'unencrypted');
      await storage.setField(id, 'nonce', '');
    }

    // Update file size if provided
    if (actualSize) {
      await storage.setField(id, 'size', actualSize.toString());
    }

    console.log('Upload completed:', {
      id,
      multipart: isMultipart,
      encrypted: fileInfo.encrypted,
    });

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

    if (!uploadId) {
      return { error: 'Missing upload ID' };
    }

    try {
      await storage.abortMultipartUpload(id, uploadId);
      await storage.redis.del(id);
      return { success: true };
    } catch (e) {
      console.error('Failed to abort multipart upload:', e);
      return { error: 'Failed to abort upload' };
    }
  }, {
    body: t.Object({
      uploadId: t.String(),
    }),
  });
