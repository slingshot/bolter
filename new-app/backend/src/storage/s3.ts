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

export class S3Storage {
  private s3: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = config.s3Bucket;

    const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
      region: 'auto',
    };

    if (config.s3Endpoint) {
      clientConfig.endpoint = config.s3Endpoint;
    }

    if (config.s3UsePathStyle) {
      clientConfig.forcePathStyle = true;
    }

    this.s3 = new S3Client(clientConfig);
  }

  async length(id: string): Promise<number> {
    const result = await this.s3.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: id,
    }));
    return result.ContentLength || 0;
  }

  async getStream(id: string): Promise<ReadableStream<Uint8Array> | null> {
    const result = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: id,
    }));
    return result.Body?.transformToWebStream() || null;
  }

  async set(id: string, data: Buffer | Uint8Array | ReadableStream): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: id,
      Body: data as any,
    }));
  }

  async del(id: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: id,
    }));
  }

  async ping(): Promise<boolean> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async getSignedDownloadUrl(id: string, filename?: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: id,
      ...(filename && {
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
      }),
    });
    return getSignedUrl(this.s3, command, { expiresIn });
  }

  async getSignedUploadUrl(id: string, expiresIn = 3600): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: id,
    });
    return getSignedUrl(this.s3, command, { expiresIn });
  }

  async createMultipartUpload(id: string): Promise<string> {
    const result = await this.s3.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: id,
    }));
    return result.UploadId || '';
  }

  async getSignedMultipartUploadUrl(
    id: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 3600
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: id,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.s3, command, { expiresIn });
  }

  async completeMultipartUpload(
    id: string,
    uploadId: string,
    parts: CompletedPart[]
  ): Promise<void> {
    await this.s3.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: id,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
  }

  async abortMultipartUpload(id: string, uploadId: string): Promise<void> {
    await this.s3.send(new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: id,
      UploadId: uploadId,
    }));
  }
}

export const s3Storage = new S3Storage();
