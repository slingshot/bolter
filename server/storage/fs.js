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

  getSignedUrl(_id) {
    // For filesystem storage, we can't generate pre-signed URLs
    // Return null to indicate streaming should be used instead
    return null;
  }
}

module.exports = FSStorage;
