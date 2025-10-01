const storage = require('../storage');
const mozlog = require('../log');
const log = mozlog('send.downloadUrl');

module.exports = async function(req, res) {
  const id = req.params.id;
  try {
    const meta = req.meta;

    let filename = 'download';

    // Parse metadata to get filename
    if (meta.metadata) {
      try {
        // For unencrypted files, metadata is base64 encoded JSON
        let decodedMeta;
        if (meta.encrypted === 'false' || !meta.encrypted) {
          // Try to decode the base64 metadata
          const metadataStr = Buffer.from(meta.metadata, 'base64').toString(
            'utf8'
          );
          decodedMeta = JSON.parse(metadataStr);
        }

        if (decodedMeta) {
          if (decodedMeta.name) {
            filename = decodedMeta.name;
          } else if (decodedMeta.files && decodedMeta.files.length === 1) {
            // Single file in manifest
            filename = decodedMeta.files[0].name;
          } else if (decodedMeta.files && decodedMeta.files.length > 1) {
            // Multiple files - it's an archive
            filename = `${decodedMeta.name || 'archive'}.zip`;
          }

          // For archives, ensure .zip extension
          if (
            decodedMeta.files &&
            decodedMeta.files.length > 1 &&
            !filename.endsWith('.zip')
          ) {
            filename += '.zip';
          }
        }
      } catch (e) {
        // If we can't parse metadata, use default filename
        log.warn('Failed to parse metadata for filename', e);
      }
    }

    // Try to get a pre-signed URL with the filename
    const signedUrl = await storage.getSignedUrl(id, filename);

    if (signedUrl) {
      // We have a pre-signed URL, return it along with metadata for download count management
      res.json({
        url: signedUrl,
        useSignedUrl: true,
        contentLength: await storage.length(id),
        dlimit: meta.dlimit,
        dl: meta.dl,
        filename: filename
      });
    } else {
      // No pre-signed URL available (e.g., filesystem storage), client should fall back to streaming
      res.json({
        useSignedUrl: false,
        contentLength: await storage.length(id),
        dlimit: meta.dlimit,
        dl: meta.dl,
        filename: filename
      });
    }
  } catch (e) {
    log.error('downloadUrlError', e);
    res.sendStatus(404);
  }
};
