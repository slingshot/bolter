const AWS = require('aws-sdk');

class S3Storage {
  constructor(config, log) {
    this.bucket = config.s3_bucket;
    this.log = log;
    const cfg = {};
    if (config.s3_endpoint != '') {
      cfg['endpoint'] = config.s3_endpoint;
    }
    cfg['s3ForcePathStyle'] = config.s3_use_path_style_endpoint;
    cfg['signatureVersion'] = 'v4';
    AWS.config.update(cfg);
    this.s3 = new AWS.S3();
  }

  async length(id) {
    const result = await this.s3
      .headObject({ Bucket: this.bucket, Key: id })
      .promise();
    return Number(result.ContentLength);
  }

  getStream(id) {
    return this.s3
      .getObject({ Bucket: this.bucket, Key: id })
      .createReadStream();
  }

  set(id, file) {
    const upload = this.s3.upload({
      Bucket: this.bucket,
      Key: id,
      Body: file
    });
    file.on('error', () => upload.abort());
    return upload.promise();
  }

  del(id) {
    return this.s3.deleteObject({ Bucket: this.bucket, Key: id }).promise();
  }

  ping() {
    return this.s3.headBucket({ Bucket: this.bucket }).promise();
  }

  getSignedUrl(id, filename = null, expiresIn = 3600) {
    const params = {
      Bucket: this.bucket,
      Key: id,
      Expires: expiresIn
    };

    // Add ResponseContentDisposition to force download with specific filename
    if (filename) {
      params.ResponseContentDisposition = `attachment; filename="${filename}"`;
    }

    return this.s3.getSignedUrl('getObject', params);
  }

  // Single part upload pre-signed URL
  getSignedUploadUrl(id, expiresIn = 3600) {
    return this.s3.getSignedUrl('putObject', {
      Bucket: this.bucket,
      Key: id,
      Expires: expiresIn
    });
  }

  // Multipart upload methods
  async createMultipartUpload(id) {
    const result = await this.s3
      .createMultipartUpload({
        Bucket: this.bucket,
        Key: id
      })
      .promise();
    return result.UploadId;
  }

  getSignedMultipartUploadUrl(id, uploadId, partNumber, expiresIn = 3600) {
    return this.s3.getSignedUrl('uploadPart', {
      Bucket: this.bucket,
      Key: id,
      UploadId: uploadId,
      PartNumber: partNumber,
      Expires: expiresIn
    });
  }

  async completeMultipartUpload(id, uploadId, parts) {
    const result = await this.s3
      .completeMultipartUpload({
        Bucket: this.bucket,
        Key: id,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
        }
      })
      .promise();
    return result;
  }

  async abortMultipartUpload(id, uploadId) {
    await this.s3
      .abortMultipartUpload({
        Bucket: this.bucket,
        Key: id,
        UploadId: uploadId
      })
      .promise();
  }
}

module.exports = S3Storage;
