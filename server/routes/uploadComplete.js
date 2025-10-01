const storage = require('../storage');
const config = require('../config');
const mozlog = require('../log');
const log = mozlog('send.uploadComplete');

module.exports = async function(req, res) {
  try {
    const { id, metadata, parts } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'Missing file ID' });
    }

    // Get file info from Redis
    const fileInfo = await storage.redis.hgetallAsync(id);
    if (!fileInfo) {
      return res.status(404).json({ error: 'File not found' });
    }

    const isMultipart = fileInfo.multipart === 'true';

    if (isMultipart) {
      // Complete multipart upload
      if (!parts || !Array.isArray(parts)) {
        return res.status(400).json({ error: 'Missing parts data' });
      }

      // Validate parts
      const expectedParts = parseInt(fileInfo.numParts);
      if (parts.length !== expectedParts) {
        return res.status(400).json({ error: 'Invalid number of parts' });
      }

      // Complete the multipart upload
      const uploadId = fileInfo.uploadId;
      if (!uploadId) {
        return res.status(400).json({ error: 'Upload ID not found' });
      }

      const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

      await storage.completeMultipartUpload(id, uploadId, sortedParts);

      // Clean up multipart metadata
      await storage.redis.hdel(id, 'uploadId', 'multipart', 'numParts');
    }

    // Store final metadata
    if (metadata && typeof metadata === 'string') {
      await storage.setField(id, 'metadata', metadata);
    }

    // Set auth based on encryption
    const isEncrypted = fileInfo.encrypted === 'true';
    if (isEncrypted) {
      // For encrypted files, we need the auth key from the request
      const authKey = req.body.authKey;
      if (!authKey || typeof authKey !== 'string') {
        return res
          .status(400)
          .json({ error: 'Missing or invalid auth key for encrypted file' });
      }
      await storage.setField(id, 'auth', authKey);
      // Generate nonce on server side for encrypted files
      const nonce = require('crypto')
        .randomBytes(16)
        .toString('base64');
      await storage.setField(id, 'nonce', nonce);
    } else {
      await storage.setField(id, 'auth', 'unencrypted');
      await storage.setField(id, 'nonce', '');
    }

    // Update file size if provided
    if (req.body.actualSize) {
      await storage.setField(id, 'size', req.body.actualSize.toString());
    }

    log.info('uploadCompleted', {
      id,
      multipart: isMultipart,
      encrypted: isEncrypted
    });

    res.json({
      success: true,
      id,
      url: `${config.deriveBaseUrl(req)}/download/${id}#${fileInfo.owner}`
    });
  } catch (e) {
    log.error('uploadCompleteError', {
      error: e.message,
      stack: e.stack,
      id: req.body.id,
      multipart: req.body.parts ? true : false
    });

    // Try to clean up failed multipart upload
    if (req.body.id && req.body.uploadId) {
      try {
        await storage.abortMultipartUpload(req.body.id, req.body.uploadId);
      } catch (cleanupError) {
        log.error('uploadCleanupError', cleanupError);
      }
    }

    // Provide more specific error messages
    let statusCode = 500;
    let errorMessage = 'Failed to complete upload';

    if (e.code === 'NoSuchUpload') {
      statusCode = 404;
      errorMessage = 'Upload not found or expired';
    } else if (e.code === 'InvalidPart' || e.code === 'InvalidPartOrder') {
      statusCode = 400;
      errorMessage = 'Invalid upload parts';
    } else if (e.code === 'EntityTooSmall') {
      statusCode = 400;
      errorMessage = 'Upload parts too small';
    }

    res.status(statusCode).json({
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? e.message : undefined
    });
  }
};
