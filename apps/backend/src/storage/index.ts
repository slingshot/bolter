import type { CompletedPart } from '@aws-sdk/client-s3';
import { captureError } from '../lib/sentry';
import { ProviderNotFoundError, providerRegistry } from './provider-registry';
import { redis } from './redis';
import type { S3Storage } from './s3';

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
    providerId?: string;
}

/**
 * Resolve the S3Storage instance for an existing file.
 * Reads the file's `providerId` from Redis and looks it up in the registry,
 * loading it from Redis on a cache miss. Falls back to the default provider
 * only for pre-migration files (no providerId) or when the provider record
 * was genuinely deleted; any other load failure propagates so callers never
 * silently sign against the wrong bucket.
 */
export async function resolveProviderForFile(id: string): Promise<S3Storage> {
    const providerId = await redis.hGet(id, 'providerId');
    if (providerId) {
        try {
            return await providerRegistry.getOrLoadProvider(providerId);
        } catch (e) {
            if (!(e instanceof ProviderNotFoundError)) {
                throw e;
            }
            console.warn(
                `Provider "${providerId}" not found for file ${id}, falling back to default`,
            );
        }
    }
    return providerRegistry.getDefaultProvider();
}

/**
 * Resolve a provider from an explicitly pinned provider ID — used by the
 * multipart operations (create / sign part / complete / abort) that are
 * deliberately pinned to the bucket the upload was started against.
 *
 * A pinned `providerId` is authoritative. On a registry cache miss we load the
 * record from Redis (one shot) rather than substituting a *different* bucket:
 * retargeting the active provider would send CompleteMultipartUpload against a
 * bucket that never saw the upload, stranding a fully uploaded file. Cache
 * misses are reachable in multi-replica deployments inside the provider cache
 * TTL window, and persistently when a provider fails to load at startup.
 *
 * Only an absent `providerId` falls back to the active provider. A record that
 * genuinely no longer exists falls back to the default provider, mirroring
 * `resolveProviderForFile`; every other load failure propagates.
 */
export async function resolveProviderById(providerId?: string): Promise<S3Storage> {
    if (providerId) {
        try {
            return await providerRegistry.getOrLoadProvider(providerId);
        } catch (e) {
            if (!(e instanceof ProviderNotFoundError)) {
                throw e;
            }
            console.warn(`Provider "${providerId}" not found, falling back to default`);
        }
        return providerRegistry.getDefaultProvider();
    }
    return providerRegistry.getActiveProvider();
}

export const storage = {
    // Redis operations
    redis,

    // --- Upload operations (target active provider) ---

    async getSignedUploadUrl(
        id: string,
        expiresIn = 3600,
        objectExpires?: Date,
        providerId?: string,
    ): Promise<string | null> {
        try {
            const provider = await resolveProviderById(providerId);
            return await provider.getSignedUploadUrl(id, expiresIn, objectExpires);
        } catch (e) {
            captureError(e, { operation: 's3.sign-upload', extra: { id } });
            console.error('Failed to get signed upload URL:', e);
            return null;
        }
    },

    async createMultipartUpload(
        id: string,
        objectExpires?: Date,
        providerId?: string,
    ): Promise<string | null> {
        try {
            const provider = await resolveProviderById(providerId);
            return await provider.createMultipartUpload(id, objectExpires);
        } catch (e) {
            captureError(e, { operation: 's3.create-multipart', extra: { id } });
            console.error('Failed to create multipart upload:', e);
            return null;
        }
    },

    // --- Multipart operations (target specific provider if known) ---

    async getSignedMultipartUploadUrl(
        id: string,
        uploadId: string,
        partNumber: number,
        expiresIn?: number,
        providerId?: string,
    ): Promise<string> {
        const provider = await resolveProviderById(providerId);
        return provider.getSignedMultipartUploadUrl(id, uploadId, partNumber, expiresIn);
    },

    async completeMultipartUpload(
        id: string,
        uploadId: string,
        parts: CompletedPart[],
        providerId?: string,
    ): Promise<void> {
        const provider = await resolveProviderById(providerId);
        return provider.completeMultipartUpload(id, uploadId, parts);
    },

    async abortMultipartUpload(id: string, uploadId: string, providerId?: string): Promise<void> {
        const provider = await resolveProviderById(providerId);
        return provider.abortMultipartUpload(id, uploadId);
    },

    // --- Download operations (resolve from file metadata) ---

    async getSignedDownloadUrl(id: string, filename?: string): Promise<string | null> {
        try {
            const provider = await resolveProviderForFile(id);
            return await provider.getSignedDownloadUrl(id, filename);
        } catch (e) {
            captureError(e, { operation: 's3.sign-download', extra: { id, filename } });
            console.error('Failed to get signed download URL:', e);
            return null;
        }
    },

    async getStream(id: string): Promise<ReadableStream<Uint8Array> | null> {
        const provider = await resolveProviderForFile(id);
        return provider.getStream(id);
    },

    async length(id: string): Promise<number> {
        const provider = await resolveProviderForFile(id);
        return provider.length(id);
    },

    // --- Delete (resolve provider, clean up counter) ---

    async del(id: string): Promise<void> {
        // Read providerId before deleting metadata; resolve like
        // resolveProviderForFile so a registry cache miss can never delete
        // metadata while leaving the object behind in the real bucket
        const providerId = await redis.hGet(id, 'providerId');
        const provider = await resolveProviderForFile(id);

        await Promise.all([
            // Deliberate: an S3 delete failure must not strand undeletable
            // Redis metadata, so only the object leg is swallowed
            provider.del(id).catch((e) => {
                captureError(e, { operation: 's3.delete', extra: { id }, level: 'warning' });
            }),
            // The provider bookkeeping is gated on DEL's reply: only the caller
            // whose DEL actually removed the key decrements. Two concurrent
            // deletes of the same file (an owner /delete racing the auto-delete
            // from /download/complete) would otherwise each decrement, dropping
            // the counter by two. The bookkeeping itself stays non-fatal — the
            // metadata is gone either way.
            providerId ? providerRegistry.deleteFileMetadata(providerId, id) : redis.del(id),
        ]);
    },

    // --- Provider info ---

    getActiveProviderId(): string {
        return providerRegistry.getActiveProviderId();
    },

    // --- Metadata operations ---

    async setField(id: string, field: string, value: string): Promise<void> {
        await redis.hSet(id, field, value);

        // Pinning a file to a provider is also what registers it in that
        // provider's live-file set — the set `providerRegistry.getFileCount`
        // reads to decide whether a provider still holds files. Every upload
        // records `providerId` through this method exactly once (`/upload/url`),
        // so hooking the write here keeps the set populated without depending
        // on any caller threading an extra argument.
        //
        // Bookkeeping must never fail an upload: the metadata hash is already
        // written at this point, so a failure is reported and swallowed. The
        // guard then under-counts, which leaves the provider deletable rather
        // than wedging it — the direction this whole change is fixing.
        if (field === 'providerId' && value) {
            await providerRegistry.trackFile(value, id).catch((e) => {
                captureError(e, {
                    operation: 'provider.track-file',
                    extra: { id, providerId: value },
                    level: 'warning',
                });
            });
        }
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
            providerId: data.providerId,
        };
    },

    exists(id: string): Promise<boolean> {
        return redis.exists(id);
    },

    /**
     * Increment a file's download counter, but never resurrect a deleted key
     * (audit #7). Resolves `null` when the file vanished mid-request — callers
     * must treat that as "gone" rather than as a count of zero.
     */
    incrementDownloadCount(id: string): Promise<number | null> {
        return redis.hIncrByIfExists(id, 'dl', 1);
    },

    rotateNonce(id: string, nonce: string): Promise<boolean> {
        return redis.rotateNonce(id, nonce);
    },

    getTTL(id: string): Promise<number> {
        return redis.ttl(id);
    },

    // --- Health checks ---

    async ping(): Promise<{ redis: boolean; s3: boolean; providers?: Record<string, boolean> }> {
        const [redisOk, providerHealth] = await Promise.all([
            redis.ping(),
            providerRegistry.healthCheckAll(),
        ]);
        const activeId = providerRegistry.getActiveProviderId();
        return {
            redis: redisOk,
            s3: providerHealth[activeId] ?? false,
            providers: providerHealth,
        };
    },
};

export type { CompletedPart };
