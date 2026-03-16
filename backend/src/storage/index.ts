import type { CompletedPart } from '@aws-sdk/client-s3';
import { captureError } from '../lib/sentry';
import { redis } from './redis';
import { s3Storage } from './s3';

export interface FileMetadata {
    id: string;
    prefix: string;
    owner: string;
    encrypted: boolean;
    dl: number;
    dlimit: number;
    fileSize: number;
    metadata?: string;
    auth?: string;
    nonce?: string;
    uploadId?: string;
    multipart?: boolean;
    numParts?: number;
    partSize?: number;
}

export const storage = {
    // Redis operations
    redis,

    // S3 operations
    async getSignedUploadUrl(id: string, objectExpires?: Date): Promise<string | null> {
        try {
            return await s3Storage.getSignedUploadUrl(id, 3600, objectExpires);
        } catch (e) {
            captureError(e, { operation: 's3.sign-upload', extra: { id } });
            console.error('Failed to get signed upload URL:', e);
            return null;
        }
    },

    async getSignedDownloadUrl(id: string, filename?: string): Promise<string | null> {
        try {
            return await s3Storage.getSignedDownloadUrl(id, filename);
        } catch (e) {
            captureError(e, { operation: 's3.sign-download', extra: { id, filename } });
            console.error('Failed to get signed download URL:', e);
            return null;
        }
    },

    async createMultipartUpload(id: string, objectExpires?: Date): Promise<string | null> {
        try {
            return await s3Storage.createMultipartUpload(id, objectExpires);
        } catch (e) {
            captureError(e, { operation: 's3.create-multipart', extra: { id } });
            console.error('Failed to create multipart upload:', e);
            return null;
        }
    },

    getSignedMultipartUploadUrl(
        id: string,
        uploadId: string,
        partNumber: number,
        expiresIn?: number,
    ): Promise<string> {
        return s3Storage.getSignedMultipartUploadUrl(id, uploadId, partNumber, expiresIn);
    },

    completeMultipartUpload(id: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
        return s3Storage.completeMultipartUpload(id, uploadId, parts);
    },

    abortMultipartUpload(id: string, uploadId: string): Promise<void> {
        return s3Storage.abortMultipartUpload(id, uploadId);
    },

    getStream(id: string): Promise<ReadableStream<Uint8Array> | null> {
        return s3Storage.getStream(id);
    },

    length(id: string): Promise<number> {
        return s3Storage.length(id);
    },

    async del(id: string): Promise<void> {
        await Promise.all([
            s3Storage.del(id).catch((e) => {
                captureError(e, { operation: 's3.delete', extra: { id }, level: 'warning' });
            }),
            redis.del(id),
        ]);
    },

    // Metadata operations
    async setField(id: string, field: string, value: string): Promise<void> {
        await redis.hSet(id, field, value);
    },

    getField(id: string, field: string): Promise<string | null> {
        return redis.hGet(id, field);
    },

    async getMetadata(id: string): Promise<FileMetadata | null> {
        const data = await redis.hGetAll(id);
        if (!data) {
            return null;
        }

        return {
            id,
            prefix: data.prefix || '',
            owner: data.owner || '',
            encrypted: data.encrypted === 'true',
            dl: parseInt(data.dl || '0', 10),
            dlimit: parseInt(data.dlimit || '1', 10),
            fileSize: parseInt(data.fileSize || '0', 10),
            metadata: data.metadata,
            auth: data.auth,
            nonce: data.nonce,
            uploadId: data.uploadId,
            multipart: data.multipart === 'true',
            numParts: data.numParts ? parseInt(data.numParts, 10) : undefined,
            partSize: data.partSize ? parseInt(data.partSize, 10) : undefined,
        };
    },

    exists(id: string): Promise<boolean> {
        return redis.exists(id);
    },

    incrementDownloadCount(id: string): Promise<number> {
        return redis.hIncrBy(id, 'dl', 1);
    },

    getTTL(id: string): Promise<number> {
        return redis.ttl(id);
    },

    // Health checks
    async ping(): Promise<{ redis: boolean; s3: boolean }> {
        const [redisOk, s3Ok] = await Promise.all([redis.ping(), s3Storage.ping()]);
        return { redis: redisOk, s3: s3Ok };
    },
};

export type { CompletedPart };
