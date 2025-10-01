import { blobStream, concatStream } from './streams';
import Zip from './zip';

function isDupe(newFile, array) {
  for (const file of array) {
    if (
      newFile.name === file.name &&
      newFile.size === file.size &&
      newFile.lastModified === file.lastModified
    ) {
      return true;
    }
  }
  return false;
}

export default class Archive {
  constructor(files = [], defaultTimeLimit = 86400, defaultDownloadLimit = 1) {
    this.files = Array.from(files);
    this.defaultTimeLimit = defaultTimeLimit;
    this.defaultDownloadLimit = defaultDownloadLimit;
    this.timeLimit = defaultTimeLimit;
    this.dlimit = defaultDownloadLimit;
    this.password = null;
    this.encrypted = false;
  }

  get name() {
    return this.files.length > 1 ? 'Send-Archive.zip' : this.files[0].name;
  }

  get type() {
    return this.files.length > 1 ? 'send-archive' : this.files[0].type;
  }

  get size() {
    const rawSize = this.files.reduce((total, file) => total + file.size, 0);
    // For unencrypted multi-file archives, add ZIP overhead
    if (!this.encrypted && this.files.length > 1) {
      // Calculate ZIP overhead: headers, data descriptors, central directory
      const zip = new Zip(this.manifest, null);
      return rawSize + zip.size;
    }
    return rawSize;
  }

  get numFiles() {
    return this.files.length;
  }

  get manifest() {
    return {
      files: this.files.map(file => ({
        name: file.name,
        size: file.size,
        type: file.type
      }))
    };
  }

  get stream() {
    // For encrypted files or single files, concatenate raw streams
    // For unencrypted multi-file archives, create a ZIP stream
    if (!this.encrypted && this.files.length > 1) {
      const rawStream = concatStream(this.files.map(file => blobStream(file)));
      const zip = new Zip(this.manifest, rawStream);
      return zip.stream;
    } else {
      return concatStream(this.files.map(file => blobStream(file)));
    }
  }

  addFiles(files, maxSize, maxFiles) {
    if (this.files.length + files.length > maxFiles) {
      throw new Error('tooManyFiles');
    }
    const newFiles = files.filter(
      file => file.size > 0 && !isDupe(file, this.files)
    );
    const newSize = newFiles.reduce((total, file) => total + file.size, 0);
    if (this.size + newSize > maxSize) {
      throw new Error('fileTooBig');
    }
    this.files = this.files.concat(newFiles);
    return true;
  }

  remove(file) {
    const index = this.files.indexOf(file);
    if (index > -1) {
      this.files.splice(index, 1);
    }
  }

  clear() {
    this.files = [];
    this.dlimit = this.defaultDownloadLimit;
    this.timeLimit = this.defaultTimeLimit;
    this.password = null;
    this.encrypted = false;
  }
}
