import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { s3Logger as logger } from '../logger';

export class S3Storage {
  private s3: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = config.s3Bucket;

    const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
      region: 'auto',
      // Disable automatic checksums - R2 doesn't fully support SDK v3 flexible checksums
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };

    if (config.s3Endpoint) {
      clientConfig.endpoint = config.s3Endpoint;
    }

    if (config.s3UsePathStyle) {
      clientConfig.forcePathStyle = true;
    }

    logger.info({
      bucket: this.bucket,
      endpoint: config.s3Endpoint,
      pathStyle: config.s3UsePathStyle,
    }, 'S3 client initialized');

    this.s3 = new S3Client(clientConfig);
  }

  async length(id: string): Promise<number> {
    logger.debug({ id }, 'Getting object length');
    const result = await this.s3.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: id,
    }));
    const length = result.ContentLength || 0;
    logger.debug({ id, length }, 'Object length retrieved');
    return length;
  }

  async getStream(id: string): Promise<ReadableStream<Uint8Array> | null> {
    logger.debug({ id }, 'Getting object stream');
    const result = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: id,
    }));
    logger.debug({ id, hasBody: !!result.Body }, 'Object stream retrieved');
    return result.Body?.transformToWebStream() || null;
  }

  async set(id: string, data: Buffer | Uint8Array | ReadableStream): Promise<void> {
    logger.debug({ id }, 'Putting object');
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: id,
      Body: data as any,
    }));
    logger.debug({ id }, 'Object put successfully');
  }

  async del(id: string): Promise<void> {
    logger.debug({ id }, 'Deleting object');
    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: id,
    }));
    logger.debug({ id }, 'Object deleted');
  }

  async ping(): Promise<boolean> {
    logger.debug({ bucket: this.bucket }, 'Pinging S3 bucket');
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      logger.debug({ bucket: this.bucket }, 'S3 bucket ping successful');
      return true;
    } catch (err) {
      logger.error({ bucket: this.bucket, error: err }, 'S3 bucket ping failed');
      return false;
    }
  }

  async getSignedDownloadUrl(id: string, filename?: string, expiresIn = 3600): Promise<string> {
    logger.debug({ id, filename, expiresIn }, 'Generating signed download URL');
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: id,
      ...(filename && {
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
      }),
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn });
    logger.debug({ id, urlLength: url.length, urlPreview: url.substring(0, 100) + '...' }, 'Signed download URL generated');
    return url;
  }

  async getSignedUploadUrl(id: string, expiresIn = 3600, _objectExpires?: Date): Promise<string> {
    logger.debug({ id, expiresIn }, 'Generating signed upload URL');
    const startTime = Date.now();

    // Note: We don't include Expires header here because:
    // 1. It gets included in SignedHeaders, requiring the client to send it
    // 2. R2 uses bucket lifecycle rules for object expiration, not the Expires header
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: id,
    });

    logger.debug({
      id,
      bucket: this.bucket,
      commandInput: command.input,
    }, 'PutObjectCommand created for signing');

    try {
      const url = await getSignedUrl(this.s3, command, { expiresIn });
      const duration = Date.now() - startTime;

      logger.info({
        id,
        duration,
        urlLength: url.length,
        urlPreview: url.substring(0, 150) + '...',
        fullUrl: url,
      }, 'Signed upload URL generated');

      return url;
    } catch (err) {
      logger.error({ id, error: err }, 'Failed to generate signed upload URL');
      throw err;
    }
  }

  async createMultipartUpload(id: string, _objectExpires?: Date): Promise<string> {
    logger.info({ id, bucket: this.bucket }, 'Creating multipart upload');
    const startTime = Date.now();

    try {
      // Note: R2 uses bucket lifecycle rules for object expiration, not the Expires header
      const result = await this.s3.send(new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: id,
      }));
      const duration = Date.now() - startTime;

      logger.info({
        id,
        uploadId: result.UploadId,
        duration,
      }, 'Multipart upload created');

      return result.UploadId || '';
    } catch (err) {
      logger.error({
        id,
        bucket: this.bucket,
        error: err,
        errorName: (err as Error).name,
        errorMessage: (err as Error).message,
      }, 'Failed to create multipart upload');
      throw err;
    }
  }

  async getSignedMultipartUploadUrl(
    id: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 3600
  ): Promise<string> {
    logger.debug({ id, uploadId, partNumber, expiresIn }, 'Generating signed multipart upload URL');
    const startTime = Date.now();

    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: id,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    try {
      const url = await getSignedUrl(this.s3, command, { expiresIn });
      const duration = Date.now() - startTime;

      // Log first and every 100th part, plus sampling
      if (partNumber === 1 || partNumber % 100 === 0) {
        logger.info({
          id,
          uploadId,
          partNumber,
          duration,
          urlPreview: url.substring(0, 150) + '...',
        }, 'Signed multipart upload URL generated');
      } else {
        logger.debug({ id, uploadId, partNumber, duration }, 'Signed multipart upload URL generated');
      }

      return url;
    } catch (err) {
      logger.error({
        id,
        uploadId,
        partNumber,
        error: err,
        errorName: (err as Error).name,
        errorMessage: (err as Error).message,
      }, 'Failed to generate signed multipart upload URL');
      throw err;
    }
  }

  async completeMultipartUpload(
    id: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<void> {
    logger.info({
      id,
      uploadId,
      partsCount: parts.length,
      firstPart: parts[0],
      lastPart: parts[parts.length - 1],
    }, 'Completing multipart upload');
    const startTime = Date.now();

    try {
      await this.s3.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: id,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }));
      const duration = Date.now() - startTime;

      logger.info({
        id,
        uploadId,
        partsCount: parts.length,
        duration,
      }, 'Multipart upload completed successfully');
    } catch (err) {
      logger.error({
        id,
        uploadId,
        partsCount: parts.length,
        error: err,
        errorName: (err as Error).name,
        errorMessage: (err as Error).message,
        errorCode: (err as any).Code,
      }, 'Failed to complete multipart upload');
      throw err;
    }
  }

  async abortMultipartUpload(id: string, uploadId: string): Promise<void> {
    logger.info({ id, uploadId }, 'Aborting multipart upload');

    try {
      await this.s3.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: id,
        UploadId: uploadId,
      }));
      logger.info({ id, uploadId }, 'Multipart upload aborted');
    } catch (err) {
      logger.error({ id, uploadId, error: err }, 'Failed to abort multipart upload');
      throw err;
    }
  }
}

export const s3Storage = new S3Storage();
