import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ProviderInUseError, providerRegistry } from '../storage/provider-registry';
import { resolveProviderById } from '../storage/resolve-provider';

// --- Mock redis (only the surface the registry / resolver touch) ---

const mockRedis = {
    hGet: mock((_key: string, _field: string) => Promise.resolve(null as string | null)),
    hGetAll: mock((_key: string) => Promise.resolve(null as Record<string, string> | null)),
    hSet: mock((_key: string, _field: string, _value: string) => Promise.resolve()),
    hSetMultiple: mock((_key: string, _data: Record<string, string>) => Promise.resolve()),
    del: mock((_key: string) => Promise.resolve()),
    delAndDecrement: mock((_key: string, _counterKey: string) => Promise.resolve(true)),
    exists: mock((_key: string) => Promise.resolve(false)),
    sAdd: mock((_key: string, ..._members: string[]) => Promise.resolve()),
    sMembers: mock((_key: string) => Promise.resolve([] as string[])),
    sRem: mock((_key: string, ..._members: string[]) => Promise.resolve()),
    get: mock((_key: string) => Promise.resolve(null as string | null)),
    set: mock((_key: string, _value: string) => Promise.resolve()),
    incrBy: mock((_key: string, _by: number) => Promise.resolve(0)),
    decrBy: mock((_key: string, _by: number) => Promise.resolve(0)),
};

mock.module('../storage/redis', () => ({ redis: mockRedis }));

// --- Mock S3Storage so provider instances are identifiable by bucket ---

class FakeS3Storage {
    readonly providerId: string;
    readonly bucket: string;

    constructor(options: { providerId: string; bucket: string }) {
        this.providerId = options.providerId;
        this.bucket = options.bucket;
    }

    ping(): Promise<boolean> {
        return Promise.resolve(true);
    }
}

mock.module('../storage/s3', () => ({ S3Storage: FakeS3Storage }));

// --- Fixtures ---

function providerHash(
    id: string,
    flags: { isActive?: boolean; isDefault?: boolean } = {},
): Record<string, string> {
    return {
        id,
        name: id,
        bucket: `bucket-${id}`,
        endpoint: `https://${id}.example.com`,
        accessKeyId: 'AKIA1234EXAMPLE',
        secretAccessKey: 'super-secret',
        region: 'auto',
        pathStyle: 'false',
        isActive: flags.isActive ? 'true' : 'false',
        isDefault: flags.isDefault ? 'true' : 'false',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

const HASHES: Record<string, Record<string, string>> = {
    'provider:default': providerHash('default', { isDefault: true }),
    'provider:primary': providerHash('primary', { isActive: true }),
    // Deliberately NOT in the cached id list — this is the pinned-but-uncached
    // provider that finding #2 is about
    'provider:backup': providerHash('backup'),
};

/** Boot the real singleton registry with only `cachedIds` warm in memory. */
async function initRegistry(cachedIds: string[]): Promise<void> {
    providerRegistry.destroy();
    mockRedis.sMembers.mockImplementation((key: string) =>
        Promise.resolve(key === 'provider:ids' ? cachedIds : []),
    );
    mockRedis.hGetAll.mockImplementation((key: string) => Promise.resolve(HASHES[key] ?? null));
    await providerRegistry.initialize();
}

function resetRedisMocks(): void {
    for (const fn of Object.values(mockRedis)) {
        fn.mockReset();
    }
    mockRedis.hGet.mockResolvedValue(null);
    mockRedis.hGetAll.mockResolvedValue(null);
    mockRedis.hSet.mockResolvedValue(undefined);
    mockRedis.hSetMultiple.mockResolvedValue(undefined);
    mockRedis.del.mockResolvedValue(undefined);
    mockRedis.delAndDecrement.mockResolvedValue(true);
    mockRedis.exists.mockResolvedValue(false);
    mockRedis.sAdd.mockResolvedValue(undefined);
    mockRedis.sMembers.mockResolvedValue([]);
    mockRedis.sRem.mockResolvedValue(undefined);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue(undefined);
    mockRedis.incrBy.mockResolvedValue(0);
    mockRedis.decrBy.mockResolvedValue(0);
}

// ---------------------------------------------------------------------------
// Finding #2 — resolveProviderById must never substitute a different bucket
// ---------------------------------------------------------------------------

describe('resolveProviderById (finding #2)', () => {
    beforeEach(async () => {
        resetRedisMocks();
        // "primary" is the ACTIVE provider, "default" is the default one, and
        // "backup" exists in Redis but is not warm in this replica's cache
        await initRegistry(['default', 'primary']);
    });

    afterEach(() => {
        providerRegistry.destroy();
    });

    it('loads a pinned-but-uncached provider from Redis instead of retargeting the active one', async () => {
        const provider = (await resolveProviderById('backup')) as unknown as FakeS3Storage;

        expect(provider.providerId).toBe('backup');
        expect(provider.bucket).toBe('bucket-backup');
        expect(mockRedis.hGetAll).toHaveBeenCalledWith('provider:backup');
    });

    it('keeps returning the pinned provider once it is cached', async () => {
        const first = await resolveProviderById('backup');
        const second = await resolveProviderById('backup');

        expect(second).toBe(first);
    });

    it('propagates a load failure rather than signing against the active bucket', async () => {
        mockRedis.hGetAll.mockImplementation((key: string) =>
            key === 'provider:backup'
                ? Promise.reject(
                      new Error(
                          'Failed to decrypt provider secret. PROVIDER_ENCRYPTION_KEY may have changed.',
                      ),
                  )
                : Promise.resolve(HASHES[key] ?? null),
        );

        await expect(resolveProviderById('backup')).rejects.toThrow(
            'Failed to decrypt provider secret',
        );
    });

    it('falls back to the DEFAULT provider (not the active one) when the record is gone', async () => {
        mockRedis.hGetAll.mockImplementation((key: string) =>
            key === 'provider:ghost' ? Promise.resolve(null) : Promise.resolve(HASHES[key] ?? null),
        );

        const provider = (await resolveProviderById('ghost')) as unknown as FakeS3Storage;

        expect(provider.providerId).toBe('default');
    });

    it('falls back to the active provider only when no providerId is pinned', async () => {
        const provider = (await resolveProviderById()) as unknown as FakeS3Storage;

        expect(provider.providerId).toBe('primary');
    });
});

// ---------------------------------------------------------------------------
// Finding #8 — file counter must observe TTL expiry, and force must work
// ---------------------------------------------------------------------------

describe('providerRegistry.getFileCount (finding #8)', () => {
    beforeEach(async () => {
        resetRedisMocks();
        await initRegistry(['default', 'backup']);
        resetRedisMocks();
    });

    afterEach(() => {
        providerRegistry.destroy();
    });

    it('derives the live count from the file set, ignoring the monotonic counter', async () => {
        // The raw counter has drifted far above reality because TTL expiry
        // never decrements it
        mockRedis.get.mockResolvedValue('6500');
        mockRedis.sMembers.mockResolvedValue(['file-a', 'file-b', 'file-c']);
        mockRedis.exists.mockImplementation((key: string) => Promise.resolve(key !== 'file-b'));

        const count = await providerRegistry.getFileCount('backup');

        expect(count).toBe(2);
    });

    it('prunes ids whose metadata has already TTL-expired', async () => {
        mockRedis.sMembers.mockResolvedValue(['file-a', 'file-b']);
        mockRedis.exists.mockResolvedValue(false);

        const count = await providerRegistry.getFileCount('backup');

        expect(count).toBe(0);
        expect(mockRedis.sRem).toHaveBeenCalledWith('provider:backup:files', 'file-a', 'file-b');
    });

    it('reports zero for a provider whose files all expired, however large the counter', async () => {
        mockRedis.get.mockResolvedValue('6500');
        mockRedis.sMembers.mockResolvedValue([]);

        expect(await providerRegistry.getFileCount('backup')).toBe(0);
    });
});

describe('providerRegistry.removeProvider (finding #8)', () => {
    beforeEach(async () => {
        resetRedisMocks();
        await initRegistry(['default', 'backup']);
        resetRedisMocks();
    });

    afterEach(() => {
        providerRegistry.destroy();
    });

    it('deletes when force is set even though files still reference the provider', async () => {
        mockRedis.get.mockResolvedValue('6500');
        mockRedis.sMembers.mockResolvedValue(['file-a']);
        mockRedis.exists.mockResolvedValue(true);

        await providerRegistry.removeProvider('backup', { force: true });

        expect(mockRedis.del).toHaveBeenCalledWith('provider:backup');
        expect(mockRedis.del).toHaveBeenCalledWith('provider:backup:filecount');
        expect(mockRedis.del).toHaveBeenCalledWith('provider:backup:files');
        expect(mockRedis.sRem).toHaveBeenCalledWith('provider:ids', 'backup');
        expect(providerRegistry.getProviderConfig('backup')).toBeUndefined();
    });

    it('is deletable without force once every file has expired, whatever the counter says', async () => {
        mockRedis.get.mockResolvedValue('6500');
        mockRedis.sMembers.mockResolvedValue(['file-a', 'file-b']);
        mockRedis.exists.mockResolvedValue(false);

        await providerRegistry.removeProvider('backup');

        expect(mockRedis.del).toHaveBeenCalledWith('provider:backup');
        expect(providerRegistry.getProviderConfig('backup')).toBeUndefined();
    });

    it('refuses without force and reports the live count via ProviderInUseError', async () => {
        mockRedis.sMembers.mockResolvedValue(['file-a', 'file-b']);
        mockRedis.exists.mockResolvedValue(true);

        let thrown: unknown;
        try {
            await providerRegistry.removeProvider('backup');
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(ProviderInUseError);
        expect((thrown as ProviderInUseError).fileCount).toBe(2);
        expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('still refuses to delete the default provider even with force', async () => {
        await expect(providerRegistry.removeProvider('default', { force: true })).rejects.toThrow(
            'Cannot delete the default provider',
        );
    });
});

describe('providerRegistry.incrementFileCount (finding #8)', () => {
    beforeEach(async () => {
        resetRedisMocks();
        await initRegistry(['default', 'backup']);
        resetRedisMocks();
    });

    afterEach(() => {
        providerRegistry.destroy();
    });

    it('records the file id so the count can later observe TTL expiry', async () => {
        await providerRegistry.incrementFileCount('backup', 'file-a');

        expect(mockRedis.incrBy).toHaveBeenCalledWith('provider:backup:filecount', 1);
        expect(mockRedis.sAdd).toHaveBeenCalledWith('provider:backup:files', 'file-a');
    });

    it('stays backwards compatible when no file id is supplied', async () => {
        await providerRegistry.incrementFileCount('backup');

        expect(mockRedis.incrBy).toHaveBeenCalledWith('provider:backup:filecount', 1);
        expect(mockRedis.sAdd).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Finding #24 — concurrent deletes must not double-decrement the counter
// ---------------------------------------------------------------------------

describe('providerRegistry.deleteFileMetadata (finding #24)', () => {
    beforeEach(async () => {
        resetRedisMocks();
        await initRegistry(['default', 'backup']);
        resetRedisMocks();
    });

    afterEach(() => {
        providerRegistry.destroy();
    });

    it('deletes the hash and decrements through one conditional operation', async () => {
        mockRedis.delAndDecrement.mockResolvedValue(true);

        const removed = await providerRegistry.deleteFileMetadata('backup', 'file-a');

        expect(removed).toBe(true);
        expect(mockRedis.delAndDecrement).toHaveBeenCalledWith(
            'file-a',
            'provider:backup:filecount',
        );
        // The decrement is inside the conditional op, never an extra blind one
        expect(mockRedis.decrBy).not.toHaveBeenCalled();
        expect(mockRedis.sRem).toHaveBeenCalledWith('provider:backup:files', 'file-a');
    });

    it('does not decrement when another caller already removed the key', async () => {
        mockRedis.delAndDecrement.mockResolvedValue(false);

        const removed = await providerRegistry.deleteFileMetadata('backup', 'file-a');

        expect(removed).toBe(false);
        expect(mockRedis.decrBy).not.toHaveBeenCalled();
    });

    it('decrements exactly once when two deletes race for the same file', async () => {
        // Emulate Redis DEL semantics: only the first caller removes the key,
        // and only that caller's decrement runs
        let alreadyDeleted = false;
        mockRedis.delAndDecrement.mockImplementation(async (_key: string, counterKey: string) => {
            if (alreadyDeleted) {
                return false;
            }
            alreadyDeleted = true;
            await mockRedis.decrBy(counterKey, 1);
            return true;
        });

        const results = await Promise.all([
            providerRegistry.deleteFileMetadata('backup', 'file-a'),
            providerRegistry.deleteFileMetadata('backup', 'file-a'),
        ]);

        expect(results.filter(Boolean).length).toBe(1);
        expect(mockRedis.decrBy).toHaveBeenCalledTimes(1);
    });

    it('never fails a delete because the set bookkeeping failed', async () => {
        mockRedis.delAndDecrement.mockResolvedValue(true);
        mockRedis.sRem.mockRejectedValue(new Error('redis blip'));

        expect(await providerRegistry.deleteFileMetadata('backup', 'file-a')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Finding #27 — a provider slug of "ids" collides with the index SET key
// ---------------------------------------------------------------------------

describe('providerRegistry.addProvider reserved slugs (finding #27)', () => {
    const input = {
        bucket: 'some-bucket',
        endpoint: 'https://example.com',
        accessKeyId: 'AKIA1234EXAMPLE',
        secretAccessKey: 'super-secret',
    };

    beforeEach(async () => {
        resetRedisMocks();
        await initRegistry(['default']);
        resetRedisMocks();
    });

    afterEach(() => {
        providerRegistry.destroy();
    });

    it('rejects a name whose slug collides with the provider index set key', async () => {
        await expect(providerRegistry.addProvider({ ...input, name: 'ids' })).rejects.toThrow(
            /reserved/i,
        );

        // Must never HSET onto provider:ids, which holds a SET (WRONGTYPE)
        expect(mockRedis.hSetMultiple).not.toHaveBeenCalled();
        expect(providerRegistry.getProviderConfig('ids')).toBeUndefined();
    });

    it('rejects names that only slugify to the reserved id', async () => {
        await expect(providerRegistry.addProvider({ ...input, name: 'IDS' })).rejects.toThrow(
            /reserved/i,
        );
        await expect(providerRegistry.addProvider({ ...input, name: '-ids-' })).rejects.toThrow(
            /reserved/i,
        );

        expect(mockRedis.hSetMultiple).not.toHaveBeenCalled();
    });

    it('still accepts a normal provider name', async () => {
        const cfg = await providerRegistry.addProvider({ ...input, name: 'R2 EU' });

        expect(cfg.id).toBe('r2-eu');
        expect(mockRedis.hSetMultiple).toHaveBeenCalled();
        expect(mockRedis.sAdd).toHaveBeenCalledWith('provider:ids', 'r2-eu');
    });
});
