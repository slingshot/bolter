const fs = require('fs');
const path = require('path');
const promisify = require('util').promisify;

const stat = promisify(fs.stat);

class FSStorage {
  constructor(config, log) {
    this.log = log;
    this.dir = config.file_dir;
    fs.mkdirSync(this.dir, {
      recursive: true
    });
  }

  async length(id) {
    const result = await stat(path.join(this.dir, id));
    return result.size;
  }

  getStream(id) {
    return fs.createReadStream(path.join(this.dir, id));
  }

  set(id, file) {
    return new Promise((resolve, reject) => {
      const filepath = path.join(this.dir, id);
      const fstream = fs.createWriteStream(filepath);
      file.pipe(fstream);
      file.on('error', err => {
        fstream.destroy(err);
      });
      fstream.on('error', err => {
        fs.unlinkSync(filepath);
        reject(err);
      });
      fstream.on('finish', resolve);
    });
  }

  del(id) {
    return Promise.resolve(fs.unlinkSync(path.join(this.dir, id)));
  }

  ping() {
    return Promise.resolve();
  }

  getSignedUrl(_id, _filename = null) {
    // For filesystem storage, we can't generate pre-signed URLs
    // Return null to indicate streaming should be used instead
    return null;
  }

  getSignedUploadUrl(_id) {
    // For filesystem storage, we can't generate pre-signed URLs
    // Return null to indicate WebSocket upload should be used instead
    return null;
  }

  createMultipartUpload(_id) {
    // Filesystem storage doesn't support multipart uploads
    return null;
  }

  getSignedMultipartUploadUrl(_id, _uploadId, _partNumber) {
    // Filesystem storage doesn't support multipart uploads
    return null;
  }

  completeMultipartUpload(_id, _uploadId, _parts) {
    // Filesystem storage doesn't support multipart uploads
    return null;
  }

  abortMultipartUpload(_id, _uploadId) {
    // Filesystem storage doesn't support multipart uploads
    return null;
  }
}

module.exports = FSStorage;
