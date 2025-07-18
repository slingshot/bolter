const storage = require('../storage');
const mozlog = require('../log');
const log = mozlog('send.uploadAbort');

module.exports = async function(req, res) {
  try {
    const id = req.params.id;
    const { uploadId } = req.body;

    if (!uploadId) {
      return res.status(400).json({ error: 'Missing upload ID' });
    }

    // Get file info from Redis
    const fileInfo = await storage.redis.hgetallAsync(id);
    if (!fileInfo) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Abort the multipart upload
    await storage.abortMultipartUpload(id, uploadId);

    // Clean up Redis metadata
    await storage.redis.del(id);

    log.info('uploadAborted', { id, uploadId });

    res.json({ success: true });
  } catch (e) {
    log.error('uploadAbortError', e);
    res.status(500).json({ error: 'Failed to abort upload' });
  }
};
