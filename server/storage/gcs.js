const { Storage } = require('@google-cloud/storage');
const storage = new Storage();

class GCSStorage {
  constructor(config, log) {
    this.bucket = storage.bucket(config.gcs_bucket);
    this.log = log;
  }

  async length(id) {
    const data = await this.bucket.file(id).getMetadata();
    return data[0].size;
  }

  getStream(id) {
    return this.bucket.file(id).createReadStream({ validation: false });
  }

  set(id, file) {
    return new Promise((resolve, reject) => {
      file
        .pipe(
          this.bucket.file(id).createWriteStream({
            validation: false,
            resumable: true
          })
        )
        .on('error', reject)
        .on('finish', resolve);
    });
  }

  del(id) {
    return this.bucket.file(id).delete();
  }

  ping() {
    return this.bucket.exists();
  }

  async getSignedUrl(id, expiresIn = 3600) {
    const [url] = await this.bucket.file(id).getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresIn * 1000
    });
    return url;
  }

  // Single part upload pre-signed URL
  async getSignedUploadUrl(id, expiresIn = 3600) {
    const [url] = await this.bucket.file(id).getSignedUrl({
      action: 'write',
      expires: Date.now() + expiresIn * 1000
    });
    return url;
  }

  // Multipart upload methods (GCS doesn't have native multipart like S3)
  // We'll use resumable uploads instead
  async createMultipartUpload(id) {
    // Return a fake upload ID - we'll handle resumable uploads differently
    return `gcs-resumable-${id}-${Date.now()}`;
  }

  async getSignedMultipartUploadUrl(
    id,
    uploadId,
    partNumber,
    expiresIn = 3600
  ) {
    // For GCS, we'll return a regular signed URL for each part
    // The client will need to handle resumable uploads differently
    const [url] = await this.bucket
      .file(`${id}-part-${partNumber}`)
      .getSignedUrl({
        action: 'write',
        expires: Date.now() + expiresIn * 1000
      });
    return url;
  }

  async completeMultipartUpload(id, uploadId, parts) {
    // For GCS, we need to compose the parts into a single file
    const partFiles = parts.map(part =>
      this.bucket.file(`${id}-part-${part.PartNumber}`)
    );

    const finalFile = this.bucket.file(id);
    await finalFile.save(
      Buffer.concat(
        await Promise.all(
          partFiles.map(file => file.download().then(data => data[0]))
        )
      )
    );

    // Clean up part files
    await Promise.all(partFiles.map(file => file.delete()));

    return { Location: `gs://${this.bucket.name}/${id}` };
  }

  async abortMultipartUpload(id, _uploadId) {
    // Clean up any partial uploads
    const [files] = await this.bucket.getFiles({ prefix: `${id}-part-` });
    await Promise.all(files.map(file => file.delete()));
  }
}

module.exports = GCSStorage;
