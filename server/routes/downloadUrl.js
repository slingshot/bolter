const storage = require('../storage');
const mozlog = require('../log');
const log = mozlog('send.downloadUrl');

module.exports = async function(req, res) {
  const id = req.params.id;
  try {
    const meta = req.meta;

    // Try to get a pre-signed URL
    const signedUrl = await storage.getSignedUrl(id);

    if (signedUrl) {
      // We have a pre-signed URL, return it along with metadata for download count management
      res.json({
        url: signedUrl,
        useSignedUrl: true,
        contentLength: await storage.length(id),
        dlimit: meta.dlimit,
        dl: meta.dl
      });
    } else {
      // No pre-signed URL available (e.g., filesystem storage), client should fall back to streaming
      res.json({
        useSignedUrl: false,
        contentLength: await storage.length(id),
        dlimit: meta.dlimit,
        dl: meta.dl
      });
    }
  } catch (e) {
    log.error('downloadUrlError', e);
    res.sendStatus(404);
  }
};
