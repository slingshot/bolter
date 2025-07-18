const crypto = require('crypto');
const storage = require('../storage');
const config = require('../config');
const mozlog = require('../log');
const log = mozlog('send.uploadUrl');

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
const PART_SIZE = 50 * 1024 * 1024; // 50MB per part

module.exports = async function(req, res) {
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
      // Create multipart upload
      const uploadId = await storage.createMultipartUpload(id);
      if (!uploadId) {
        return res.json({ useSignedUrl: false });
      }

      // Calculate number of parts
      const numParts = Math.ceil(fileSize / PART_SIZE);
      const parts = [];

      for (let i = 1; i <= numParts; i++) {
        const partUrl = await storage.getSignedMultipartUploadUrl(
          id,
          uploadId,
          i
        );
        parts.push({
          partNumber: i,
          url: partUrl,
          minSize: i === numParts ? 0 : PART_SIZE,
          maxSize: PART_SIZE
        });
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
        partSize: PART_SIZE,
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
