const crypto = require('crypto');
const storage = require('../storage');
const config = require('../config');
const mozlog = require('../log');
const log = mozlog('send.uploadUrl');

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
const DEFAULT_PART_SIZE = 50 * 1024 * 1024; // 50MB per part
const MAX_PARTS = 10000; // Cloudflare R2 limit
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5GB per part (Cloudflare R2 limit)

function calculateOptimalPartSize(fileSize) {
  // Start with default part size
  let partSize = DEFAULT_PART_SIZE;
  let numParts = Math.ceil(fileSize / partSize);

  // If we exceed max parts, increase part size
  if (numParts > MAX_PARTS) {
    partSize = Math.ceil(fileSize / MAX_PARTS);

    // Ensure part size doesn't exceed maximum
    if (partSize > MAX_PART_SIZE) {
      throw new Error(
        `File too large: would require parts larger than 5GB limit`
      );
    }

    // Round up to nearest MB for cleaner part sizes
    partSize = Math.ceil(partSize / (1024 * 1024)) * (1024 * 1024);
    numParts = Math.ceil(fileSize / partSize);
  }

  return { partSize, numParts };
}

module.exports = async function(req, res) {
  // Increase timeout for very large files
  const timeoutMs = 300000; // 5 minutes
  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs);

  try {
    const { fileSize, encrypted, timeLimit, dlimit } = req.body;

    if (!fileSize || fileSize < 0) {
      return res.status(400).json({ error: 'Invalid file size' });
    }

    // Check if we can use pre-signed URLs
    const testUploadUrl = await storage.getSignedUploadUrl('test');
    if (!testUploadUrl) {
      // Fall back to WebSocket upload
      return res.json({ useSignedUrl: false });
    }

    // Generate file ID and owner token
    const id = crypto.randomBytes(8).toString('hex');
    const owner = crypto.randomBytes(10).toString('hex');

    // Store initial metadata in Redis
    const expireSeconds = Math.min(
      timeLimit || config.default_expire_seconds,
      config.max_expire_seconds
    );
    const prefix = Math.max(Math.floor(expireSeconds / 86400), 1);

    // Store metadata for later completion
    await storage.setField(id, 'prefix', prefix);
    await storage.setField(id, 'owner', owner);
    await storage.setField(id, 'encrypted', encrypted ? 'true' : 'false');
    await storage.setField(id, 'dl', '0');
    await storage.setField(id, 'dlimit', dlimit || '1');
    await storage.setField(id, 'fileSize', fileSize.toString());
    await storage.redis.expire(id, expireSeconds);

    // Determine upload strategy
    const useMultipart = fileSize > MULTIPART_THRESHOLD;

    if (useMultipart) {
      // Calculate optimal part size for this file
      const { partSize, numParts } = calculateOptimalPartSize(fileSize);

      log.info('multipartUploadPlan', {
        fileSize,
        partSize,
        numParts,
        fileSizeGB: Math.round((fileSize / (1024 * 1024 * 1024)) * 100) / 100,
        partSizeMB: Math.round(partSize / (1024 * 1024))
      });

      // Create multipart upload
      const uploadId = await storage.createMultipartUpload(id);
      if (!uploadId) {
        return res.json({ useSignedUrl: false });
      }

      // Generate URLs in parallel batches to avoid timeouts
      const BATCH_SIZE = 100; // Generate 100 URLs at a time
      const parts = [];

      for (
        let batchStart = 1;
        batchStart <= numParts;
        batchStart += BATCH_SIZE
      ) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, numParts);
        const batchPromises = [];

        for (let i = batchStart; i <= batchEnd; i++) {
          batchPromises.push(
            storage.getSignedMultipartUploadUrl(id, uploadId, i).then(url => ({
              partNumber: i,
              url: url,
              minSize: i === numParts ? 0 : partSize,
              maxSize: partSize
            }))
          );
        }

        const batchParts = await Promise.all(batchPromises);
        parts.push(...batchParts);

        // Log progress for very large uploads
        if (numParts > 1000) {
          log.info('uploadUrlProgress', {
            generated: parts.length,
            total: numParts,
            percentage: Math.round((parts.length / numParts) * 100)
          });
        }
      }

      // Store multipart upload info
      await storage.setField(id, 'uploadId', uploadId);
      await storage.setField(id, 'multipart', 'true');
      await storage.setField(id, 'numParts', numParts.toString());

      res.json({
        useSignedUrl: true,
        multipart: true,
        id,
        owner,
        uploadId,
        parts,
        partSize,
        url: `${config.deriveBaseUrl(req)}/download/${id}#${owner}`
      });
    } else {
      // Single part upload
      const uploadUrl = await storage.getSignedUploadUrl(id);

      res.json({
        useSignedUrl: true,
        multipart: false,
        id,
        owner,
        url: uploadUrl,
        completeUrl: `${config.deriveBaseUrl(req)}/download/${id}#${owner}`
      });
    }
  } catch (e) {
    log.error('uploadUrlError', e);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
};
