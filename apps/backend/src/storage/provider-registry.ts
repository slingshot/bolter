import crypto from 'node:crypto';
import { config } from '../config';
import { providerLogger as logger } from '../logger';
import { redis } from './redis';
import { S3Storage, type S3StorageOptions } from './s3';

// --- Types ---

export interface StorageProviderConfig {
    id: string;
    name: string;
    bucket: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    pathStyle: boolean;
    isActive: boolean;
    isDefault: boolean;
    createdAt: string;
    updatedAt: string;
}

export type StorageProviderPublic = Omit<StorageProviderConfig, 'secretAccessKey'> & {
    accessKeyId: string; // masked
};

export interface AddProviderInput {
    name: string;
    bucket: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    pathStyle?: boolean;
    isActive?: boolean;
}

export type UpdateProviderInput = Partial<Omit<AddProviderInput, 'name'>> & { name?: string };

// --- Redis key helpers ---

const PROVIDER_KEY_PREFIX = 'provider:';
const PROVIDER_IDS_KEY = 'provider:ids';

function providerKey(id: string): string {
    return `${PROVIDER_KEY_PREFIX}${id}`;
}

function filecountKey(id: string): string {
    return `${PROVIDER_KEY_PREFIX}${id}:filecount`;
}

// --- Secret encryption ---

function getEncryptionKey(): Buffer | null {
    const hex = config.providerEncryptionKey;
    if (!hex || hex.length !== 64) {
        return null;
    }
    return Buffer.from(hex, 'hex');
}

function encryptSecret(plaintext: string): string {
    const key = getEncryptionKey();
    if (!key) {
        return plaintext;
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(ciphertext: string): string {
    const key = getEncryptionKey();
    if (!key) {
        return ciphertext;
    }

    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
        return ciphertext;
    }

    const [ivB64, authTagB64, dataB64] = parts;
    try {
        const iv = Buffer.from(ivB64, 'base64');
        const authTag = Buffer.from(authTagB64, 'base64');
        const data = Buffer.from(dataB64, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (err) {
        logger.error({ error: err }, 'Failed to decrypt provider secret - key may have changed');
        throw new Error(
            'Failed to decrypt provider secret. PROVIDER_ENCRYPTION_KEY may have changed.',
        );
    }
}

function maskAccessKeyId(key: string): string {
    if (key.length <= 8) {
        return '****';
    }
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

// --- Config serialization ---

function configToRedisHash(cfg: StorageProviderConfig): Record<string, string> {
    return {
        id: cfg.id,
        name: cfg.name,
        bucket: cfg.bucket,
        endpoint: cfg.endpoint,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: encryptSecret(cfg.secretAccessKey),
        region: cfg.region,
        pathStyle: cfg.pathStyle ? 'true' : 'false',
        isActive: cfg.isActive ? 'true' : 'false',
        isDefault: cfg.isDefault ? 'true' : 'false',
        createdAt: cfg.createdAt,
        updatedAt: cfg.updatedAt,
    };
}

function redisHashToConfig(data: Record<string, string>): StorageProviderConfig {
    return {
        id: data.id,
        name: data.name,
        bucket: data.bucket,
        endpoint: data.endpoint,
        accessKeyId: data.accessKeyId,
        secretAccessKey: decryptSecret(data.secretAccessKey),
        region: data.region || 'auto',
        pathStyle: data.pathStyle === 'true',
        isActive: data.isActive === 'true',
        isDefault: data.isDefault === 'true',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
    };
}

function configToPublic(cfg: StorageProviderConfig): StorageProviderPublic {
    const { secretAccessKey: _, ...rest } = cfg;
    return { ...rest, accessKeyId: maskAccessKeyId(cfg.accessKeyId) };
}

function createS3Instance(cfg: StorageProviderConfig): S3Storage {
    const options: S3StorageOptions = {
        providerId: cfg.id,
        bucket: cfg.bucket,
        endpoint: cfg.endpoint || undefined,
        region: cfg.region || 'auto',
        pathStyle: cfg.pathStyle,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
    };
    return new S3Storage(options);
}

// --- Provider Registry ---

export class ProviderRegistry {
    private instances = new Map<string, S3Storage>();
    private configs = new Map<string, StorageProviderConfig>();
    private defaultId = '';
    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    private initialized = false;

    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        const ids = await redis.sMembers(PROVIDER_IDS_KEY);

        if (ids.length === 0) {
            await this.registerDefaultFromEnv();
        } else {
            for (const id of ids) {
                await this.loadProvider(id);
            }
        }

        // Ensure we have a default
        if (!this.defaultId) {
            await this.registerDefaultFromEnv();
        }

        // Start cache refresh timer
        const ttl = config.providerCacheTtlSeconds * 1000;
        if (ttl > 0) {
            this.refreshTimer = setInterval(() => {
                this.refreshCache().catch((err) => {
                    logger.error({ error: err }, 'Provider cache refresh failed');
                });
            }, ttl);
        }

        this.initialized = true;

        logger.info(
            {
                providerCount: this.configs.size,
                providers: [...this.configs.keys()],
                defaultId: this.defaultId,
                activeId: this.getActiveProviderId(),
            },
            'Provider registry initialized',
        );

        if (!getEncryptionKey()) {
            logger.warn(
                'PROVIDER_ENCRYPTION_KEY not set or invalid. Provider secrets stored in plaintext in Redis.',
            );
        }
    }

    private async registerDefaultFromEnv(): Promise<void> {
        const now = new Date().toISOString();
        const envConfig: StorageProviderConfig = {
            id: 'default',
            name: 'Default (env)',
            bucket: config.s3Bucket,
            endpoint: config.s3Endpoint,
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
            region: 'auto',
            pathStyle: config.s3UsePathStyle,
            isActive: true,
            isDefault: true,
            createdAt: now,
            updatedAt: now,
        };

        // Save to Redis
        await redis.hSetMultiple(providerKey(envConfig.id), configToRedisHash(envConfig));
        await redis.sAdd(PROVIDER_IDS_KEY, envConfig.id);

        // Create instance
        this.configs.set(envConfig.id, envConfig);
        this.instances.set(envConfig.id, createS3Instance(envConfig));
        this.defaultId = envConfig.id;

        logger.info(
            { providerId: envConfig.id, bucket: envConfig.bucket },
            'Default provider registered from env vars',
        );
    }

    private async loadProvider(id: string): Promise<void> {
        const data = await redis.hGetAll(providerKey(id));
        if (!data) {
            logger.warn(
                { providerId: id },
                'Provider config not found in Redis, removing from set',
            );
            await redis.sRem(PROVIDER_IDS_KEY, id);
            return;
        }

        const cfg = redisHashToConfig(data);
        this.configs.set(id, cfg);
        this.instances.set(id, createS3Instance(cfg));

        if (cfg.isDefault) {
            this.defaultId = id;
        }
    }

    async refreshCache(): Promise<void> {
        const ids = await redis.sMembers(PROVIDER_IDS_KEY);
        const currentIds = new Set(this.configs.keys());
        const newIds = new Set(ids);

        // Remove providers no longer in Redis
        for (const id of currentIds) {
            if (!newIds.has(id)) {
                this.configs.delete(id);
                this.instances.delete(id);
                logger.info({ providerId: id }, 'Provider removed from cache (no longer in Redis)');
            }
        }

        // Load new or updated providers
        for (const id of ids) {
            await this.loadProvider(id);
        }
    }

    // --- Getters ---

    getProvider(providerId: string): S3Storage {
        const instance = this.instances.get(providerId);
        if (!instance) {
            throw new Error(`Storage provider "${providerId}" not found`);
        }
        return instance;
    }

    getActiveProvider(): S3Storage {
        for (const [id, cfg] of this.configs) {
            if (cfg.isActive) {
                const instance = this.instances.get(id);
                if (instance) {
                    return instance;
                }
            }
        }
        return this.getDefaultProvider();
    }

    getActiveProviderId(): string {
        for (const [id, cfg] of this.configs) {
            if (cfg.isActive) {
                return id;
            }
        }
        return this.defaultId;
    }

    getDefaultProvider(): S3Storage {
        const instance = this.instances.get(this.defaultId);
        if (!instance) {
            throw new Error('Default storage provider not initialized');
        }
        return instance;
    }

    getDefaultProviderId(): string {
        return this.defaultId;
    }

    getProviderConfig(id: string): StorageProviderConfig | undefined {
        return this.configs.get(id);
    }

    // --- CRUD ---

    async addProvider(input: AddProviderInput): Promise<StorageProviderConfig> {
        const id = slugify(input.name);
        if (!id) {
            throw new Error('Provider name produces an empty slug');
        }
        if (this.configs.has(id)) {
            throw new Error(`Provider "${id}" already exists`);
        }

        const now = new Date().toISOString();
        const cfg: StorageProviderConfig = {
            id,
            name: input.name,
            bucket: input.bucket,
            endpoint: input.endpoint,
            accessKeyId: input.accessKeyId,
            secretAccessKey: input.secretAccessKey,
            region: input.region || 'auto',
            pathStyle: input.pathStyle ?? false,
            isActive: input.isActive ?? false,
            isDefault: false,
            createdAt: now,
            updatedAt: now,
        };

        // Test connectivity before saving
        const testInstance = createS3Instance(cfg);
        const healthy = await testInstance.ping();
        if (!healthy) {
            throw new Error(
                `Cannot connect to provider "${cfg.name}" (bucket: ${cfg.bucket}, endpoint: ${cfg.endpoint})`,
            );
        }

        // If activating, deactivate others
        if (cfg.isActive) {
            await this.deactivateAll();
        }

        // Save to Redis
        await redis.hSetMultiple(providerKey(id), configToRedisHash(cfg));
        await redis.sAdd(PROVIDER_IDS_KEY, id);

        // Initialize file counter
        await redis.set(filecountKey(id), '0');

        // Cache
        this.configs.set(id, cfg);
        this.instances.set(id, testInstance);

        logger.info(
            { providerId: id, bucket: cfg.bucket, endpoint: cfg.endpoint, isActive: cfg.isActive },
            'Provider added',
        );

        return cfg;
    }

    async updateProvider(id: string, updates: UpdateProviderInput): Promise<StorageProviderConfig> {
        const existing = this.configs.get(id);
        if (!existing) {
            throw new Error(`Provider "${id}" not found`);
        }

        const updated: StorageProviderConfig = {
            ...existing,
            ...(updates.name !== undefined && { name: updates.name }),
            ...(updates.bucket !== undefined && { bucket: updates.bucket }),
            ...(updates.endpoint !== undefined && { endpoint: updates.endpoint }),
            ...(updates.accessKeyId !== undefined && { accessKeyId: updates.accessKeyId }),
            ...(updates.secretAccessKey !== undefined && {
                secretAccessKey: updates.secretAccessKey,
            }),
            ...(updates.region !== undefined && { region: updates.region }),
            ...(updates.pathStyle !== undefined && { pathStyle: updates.pathStyle }),
            ...(updates.isActive !== undefined && { isActive: updates.isActive }),
            isDefault: existing.isDefault, // cannot change
            updatedAt: new Date().toISOString(),
        };

        // If activating, deactivate others first
        if (updates.isActive && !existing.isActive) {
            await this.deactivateAll();
            updated.isActive = true;
        }

        // Save to Redis
        await redis.hSetMultiple(providerKey(id), configToRedisHash(updated));

        // Recreate S3 instance with new config
        this.configs.set(id, updated);
        this.instances.set(id, createS3Instance(updated));

        logger.info({ providerId: id }, 'Provider updated');
        return updated;
    }

    async removeProvider(id: string): Promise<void> {
        const cfg = this.configs.get(id);
        if (!cfg) {
            throw new Error(`Provider "${id}" not found`);
        }
        if (cfg.isDefault) {
            throw new Error('Cannot delete the default provider');
        }

        // Check active file count
        const countStr = await redis.get(filecountKey(id));
        const count = parseInt(countStr || '0', 10);
        if (count > 0) {
            throw new Error(
                `Cannot delete provider "${id}" — ${count} active file(s) still reference it`,
            );
        }

        // Remove from Redis
        await redis.del(providerKey(id));
        await redis.del(filecountKey(id));
        await redis.sRem(PROVIDER_IDS_KEY, id);

        // Remove from cache
        this.configs.delete(id);
        this.instances.delete(id);

        logger.info({ providerId: id }, 'Provider removed');
    }

    listProviders(): StorageProviderPublic[] {
        return [...this.configs.values()].map(configToPublic);
    }

    getProviderPublic(id: string): StorageProviderPublic | null {
        const cfg = this.configs.get(id);
        if (!cfg) {
            return null;
        }
        return configToPublic(cfg);
    }

    async getFileCount(id: string): Promise<number> {
        const countStr = await redis.get(filecountKey(id));
        return parseInt(countStr || '0', 10);
    }

    // --- Activation ---

    async activateProvider(id: string): Promise<StorageProviderConfig> {
        const cfg = this.configs.get(id);
        if (!cfg) {
            throw new Error(`Provider "${id}" not found`);
        }

        await this.deactivateAll();

        cfg.isActive = true;
        cfg.updatedAt = new Date().toISOString();
        await redis.hSetMultiple(providerKey(id), configToRedisHash(cfg));
        this.configs.set(id, cfg);

        logger.info({ providerId: id }, 'Provider activated');
        return cfg;
    }

    private async deactivateAll(): Promise<void> {
        for (const [id, cfg] of this.configs) {
            if (cfg.isActive) {
                cfg.isActive = false;
                cfg.updatedAt = new Date().toISOString();
                await redis.hSet(providerKey(id), 'isActive', 'false');
                await redis.hSet(providerKey(id), 'updatedAt', cfg.updatedAt);
                this.configs.set(id, cfg);
            }
        }
    }

    // --- Health ---

    async healthCheckAll(): Promise<Record<string, boolean>> {
        const results: Record<string, boolean> = {};
        const checks = [...this.instances.entries()].map(async ([id, instance]) => {
            results[id] = await instance.ping();
        });
        await Promise.all(checks);
        return results;
    }

    async healthCheckProvider(id: string): Promise<{ healthy: boolean; latencyMs: number }> {
        const instance = this.instances.get(id);
        if (!instance) {
            throw new Error(`Provider "${id}" not found`);
        }

        const start = Date.now();
        const healthy = await instance.ping();
        return { healthy, latencyMs: Date.now() - start };
    }

    // --- File count tracking ---

    async incrementFileCount(providerId: string): Promise<void> {
        await redis.incrBy(filecountKey(providerId), 1);
    }

    async decrementFileCount(providerId: string): Promise<void> {
        const result = await redis.decrBy(filecountKey(providerId), 1);
        // Clamp to 0 if somehow goes negative
        if (result < 0) {
            await redis.set(filecountKey(providerId), '0');
        }
    }

    // --- Cleanup ---

    destroy(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.instances.clear();
        this.configs.clear();
        this.initialized = false;
    }
}

export const providerRegistry = new ProviderRegistry();
