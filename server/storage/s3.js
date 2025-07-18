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

  getSignedUrl(id, expiresIn = 3600) {
    return this.s3.getSignedUrl('getObject', {
      Bucket: this.bucket,
      Key: id,
      Expires: expiresIn
    });
  }
}

module.exports = S3Storage;
