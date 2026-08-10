import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ProviderInUseError, providerRegistry } from '../storage/provider-registry';

// --- Mock redis (only the surface the registry / resolver touch) ---

const mockRedis = {
    hGet: mock((_key: string, _field: string) => Promise.resolve(null as string | null)),
    hGetAll: mock((_key: string) => Promise.resolve(null as Record<string, string> | null)),
    hSet: mock((_key: string, _field: string, _value: string) => Promise.resolve()),
    hSetMultiple: mock((_key: string, _data: Record<string, string>) => Promise.resolve()),
    del: mock((_key: string) => Promise.resolve()),
    delIfPresent: mock((_key: string) => Promise.resolve(true)),
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

mock.module('../lib/sentry', () => ({
    captureError: mock(() => undefined),
    addBreadcrumb: mock(() => undefined),
}));

// --- The REAL storage facade ---
//
// These tests deliberately exercise the production wiring
// (storage.setField -> providerRegistry.trackFile -> getFileCount ->
// removeProvider) rather than a re-implementation of it: re-implementing the
// facade in the test is precisely what would let the tracking write silently
// go missing while the tests stayed green.
//
// This file runs in its own `bun test` process (see `src/__isolated_tests__/README.md`),
// so no sibling's `mock.module` registration for `../storage`, `../storage/redis`
// or `../storage/provider-registry` exists here and a plain import resolves the
// real module graph — facade, registry singleton and the fake S3Storage above all
// consistently wired. It stays a dynamic import so it is evaluated *after* the
// `mock.module` calls above rather than being hoisted above them.
const { storage, resolveProviderById } = await import('../storage/index');

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
    mockRedis.delIfPresent.mockResolvedValue(true);
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

    it('sweeps a large set in batches instead of one round-trip per member', async () => {
        const members = Array.from({ length: 600 }, (_, i) => `file-${i}`);
        mockRedis.sMembers.mockResolvedValue(members);
        // Every other id has TTL-expired
        mockRedis.exists.mockImplementation((key: string) =>
            Promise.resolve(Number(key.slice('file-'.length)) % 2 === 0),
        );

        expect(await providerRegistry.getFileCount('backup')).toBe(300);

        // 600 probes must not cost 600 sequential round-trips, and every stale
        // id must still be pruned exactly once
        expect(mockRedis.exists).toHaveBeenCalledTimes(600);
        const pruned = mockRedis.sRem.mock.calls.flatMap((call) => call.slice(1));
        expect(mockRedis.sRem.mock.calls.length).toBeLessThan(10);
        expect(pruned.length).toBe(300);
        expect(new Set(pruned).size).toBe(300);
        expect(pruned).toContain('file-1');
        expect(pruned).not.toContain('file-2');
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

    it('still bumps the raw counter when no file id is supplied', async () => {
        await providerRegistry.incrementFileCount('backup');

        expect(mockRedis.incrBy).toHaveBeenCalledWith('provider:backup:filecount', 1);
        expect(mockRedis.sAdd).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Finding #8 — the production write path must actually populate the live-file
// set. Without this the in-use guard silently reads 0 forever and DELETE
// /providers/:id (no ?force) deletes a provider that still holds live files.
// These drive the REAL storage facade, not a stand-in for it.
// ---------------------------------------------------------------------------

describe('storage.setField provider tracking (finding #8)', () => {
    beforeEach(async () => {
        resetRedisMocks();
        await initRegistry(['default', 'backup']);
        resetRedisMocks();
    });

    afterEach(() => {
        providerRegistry.destroy();
    });

    it('registers the file on its provider when the upload pins providerId', async () => {
        // Exactly what POST /upload/url does for every upload
        await storage.setField('file-a', 'providerId', 'backup');

        expect(mockRedis.hSet).toHaveBeenCalledWith('file-a', 'providerId', 'backup');
        expect(mockRedis.sAdd).toHaveBeenCalledWith('provider:backup:files', 'file-a');
    });

    it('does not touch the live-file set for any other metadata field', async () => {
        await storage.setField('file-a', 'fileSize', '1024');
        await storage.setField('file-a', 'owner', 'owner-token');

        expect(mockRedis.sAdd).not.toHaveBeenCalled();
    });

    it('never fails the upload when the tracking write fails', async () => {
        mockRedis.sAdd.mockRejectedValue(new Error('redis blip'));

        await storage.setField('file-a', 'providerId', 'backup');

        expect(mockRedis.hSet).toHaveBeenCalledWith('file-a', 'providerId', 'backup');
    });

    it('makes the in-use guard refuse to delete a provider holding live files', async () => {
        // A tiny in-memory Redis for just the set + key existence, so the whole
        // chain runs for real: setField -> trackFile -> getFileCount ->
        // removeProvider's guard.
        const sets = new Map<string, Set<string>>();
        const liveKeys = new Set<string>();
        mockRedis.sAdd.mockImplementation((key: string, ...members: string[]) => {
            const set = sets.get(key) ?? new Set<string>();
            for (const m of members) {
                set.add(m);
            }
            sets.set(key, set);
            return Promise.resolve();
        });
        mockRedis.sMembers.mockImplementation((key: string) =>
            Promise.resolve([...(sets.get(key) ?? [])]),
        );
        mockRedis.sRem.mockImplementation((key: string, ...members: string[]) => {
            const set = sets.get(key);
            for (const m of members) {
                set?.delete(m);
            }
            return Promise.resolve();
        });
        mockRedis.exists.mockImplementation((key: string) => Promise.resolve(liveKeys.has(key)));

        await storage.setField('file-a', 'providerId', 'backup');
        await storage.setField('file-b', 'providerId', 'backup');
        liveKeys.add('file-a');
        liveKeys.add('file-b');

        expect(await providerRegistry.getFileCount('backup')).toBe(2);

        let thrown: unknown;
        try {
            await providerRegistry.removeProvider('backup');
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(ProviderInUseError);
        expect((thrown as ProviderInUseError).fileCount).toBe(2);
        expect(providerRegistry.getProviderConfig('backup')).toBeDefined();

        // ...and once those files TTL-expire the same provider becomes
        // deletable without force, with the stale ids pruned from the set
        liveKeys.clear();
        await providerRegistry.removeProvider('backup');
        expect(providerRegistry.getProviderConfig('backup')).toBeUndefined();
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

    it('deletes the hash, then decrements and untracks only on a real removal', async () => {
        mockRedis.delIfPresent.mockResolvedValue(true);

        const removed = await providerRegistry.deleteFileMetadata('backup', 'file-a');

        expect(removed).toBe(true);
        expect(mockRedis.delIfPresent).toHaveBeenCalledWith('file-a');
        expect(mockRedis.decrBy).toHaveBeenCalledWith('provider:backup:filecount', 1);
        expect(mockRedis.sRem).toHaveBeenCalledWith('provider:backup:files', 'file-a');
    });

    it('does not decrement when another caller already removed the key', async () => {
        mockRedis.delIfPresent.mockResolvedValue(false);

        const removed = await providerRegistry.deleteFileMetadata('backup', 'file-a');

        expect(removed).toBe(false);
        expect(mockRedis.decrBy).not.toHaveBeenCalled();
        expect(mockRedis.sRem).not.toHaveBeenCalled();
    });

    it('decrements exactly once when two deletes race for the same file', async () => {
        // Emulate Redis DEL semantics: only the first caller removes the key
        let alreadyDeleted = false;
        mockRedis.delIfPresent.mockImplementation(() => {
            if (alreadyDeleted) {
                return Promise.resolve(false);
            }
            alreadyDeleted = true;
            return Promise.resolve(true);
        });

        const results = await Promise.all([
            providerRegistry.deleteFileMetadata('backup', 'file-a'),
            providerRegistry.deleteFileMetadata('backup', 'file-a'),
        ]);

        expect(results.filter(Boolean).length).toBe(1);
        expect(mockRedis.decrBy).toHaveBeenCalledTimes(1);
    });

    it('never fails a delete because the set bookkeeping failed', async () => {
        mockRedis.delIfPresent.mockResolvedValue(true);
        mockRedis.sRem.mockRejectedValue(new Error('redis blip'));

        expect(await providerRegistry.deleteFileMetadata('backup', 'file-a')).toBe(true);
    });

    it('never fails a delete because the counter update failed', async () => {
        // The metadata hash is gone by then — the counter is explicitly
        // best-effort, as it was before it moved behind this method
        mockRedis.delIfPresent.mockResolvedValue(true);
        mockRedis.decrBy.mockRejectedValue(new Error('redis blip'));

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
