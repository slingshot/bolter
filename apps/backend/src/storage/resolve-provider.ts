import { ProviderNotFoundError, providerRegistry } from './provider-registry';
import { redis } from './redis';
import type { S3Storage } from './s3';

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
