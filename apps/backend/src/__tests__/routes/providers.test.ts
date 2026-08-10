import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { config } from '../../config';
import { ProviderInUseError, type StorageProviderConfig } from '../../storage/provider-registry';

// ---------------------------------------------------------------------------
// Mocks — only the singleton is replaced, so the real error classes (used by
// the route's `instanceof` check) stay intact for every other test file.
// ---------------------------------------------------------------------------

const mockRegistry = {
    getProviderConfig: mock((_id: string) => undefined as StorageProviderConfig | undefined),
    getFileCount: mock((_id: string) => Promise.resolve(0)),
    removeProvider: mock((_id: string, _options?: { force?: boolean }) => Promise.resolve()),
};

mock.module('../../storage/provider-registry', () => ({ providerRegistry: mockRegistry }));

mock.module('../../logger', () => ({
    providerLogger: {
        info: mock(() => undefined),
        warn: mock(() => undefined),
        error: mock(() => undefined),
        debug: mock(() => undefined),
    },
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { Elysia } from 'elysia';
import { providerRoutes } from '../../routes/providers';

const ADMIN_KEY = 'test-admin-key';
const originalAdminApiKey = config.adminApiKey;
config.adminApiKey = ADMIN_KEY;

afterAll(() => {
    config.adminApiKey = originalAdminApiKey;
});

function createApp() {
    return new Elysia().use(providerRoutes);
}

function del(path: string) {
    return new Request(`http://localhost${path}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
}

function makeConfig(overrides: Partial<StorageProviderConfig> = {}): StorageProviderConfig {
    return {
        id: 'backup',
        name: 'Backup',
        bucket: 'bucket-backup',
        endpoint: 'https://backup.example.com',
        accessKeyId: 'AKIA1234EXAMPLE',
        secretAccessKey: 'super-secret',
        region: 'auto',
        pathStyle: false,
        isActive: false,
        isDefault: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('DELETE /providers/:id (finding #8)', () => {
    beforeEach(() => {
        mockRegistry.getProviderConfig.mockReset();
        mockRegistry.getFileCount.mockReset();
        mockRegistry.removeProvider.mockReset();
        mockRegistry.getProviderConfig.mockReturnValue(makeConfig());
        mockRegistry.getFileCount.mockResolvedValue(0);
        mockRegistry.removeProvider.mockResolvedValue(undefined);
    });

    it('threads ?force=true down into removeProvider', async () => {
        const res = await createApp().handle(del('/providers/backup?force=true'));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(mockRegistry.removeProvider).toHaveBeenCalledWith('backup', { force: true });
    });

    it('succeeds with ?force=true even when the provider still holds files', async () => {
        // Pre-fix this surfaced as a 400 because removeProvider re-checked the
        // counter itself and threw regardless of the force override
        mockRegistry.getFileCount.mockResolvedValue(6500);
        mockRegistry.removeProvider.mockImplementation(
            (id: string, options?: { force?: boolean }) =>
                options?.force
                    ? Promise.resolve()
                    : Promise.reject(new ProviderInUseError(id, 6500)),
        );

        const res = await createApp().handle(del('/providers/backup?force=true'));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
    });

    it('passes force:false when the flag is absent', async () => {
        await createApp().handle(del('/providers/backup'));

        expect(mockRegistry.removeProvider).toHaveBeenCalledWith('backup', { force: false });
    });

    it('returns 409 with the force hint when the provider is in use', async () => {
        mockRegistry.removeProvider.mockImplementation((id: string) =>
            Promise.reject(new ProviderInUseError(id, 3)),
        );

        const res = await createApp().handle(del('/providers/backup'));
        const body = (await res.json()) as { error: string };

        expect(res.status).toBe(409);
        expect(body.error).toContain('3 active file(s)');
        expect(body.error).toContain('?force=true');
    });

    it('returns 404 for an unknown provider', async () => {
        mockRegistry.getProviderConfig.mockReturnValue(undefined);

        const res = await createApp().handle(del('/providers/nope'));

        expect(res.status).toBe(404);
        expect(mockRegistry.removeProvider).not.toHaveBeenCalled();
    });

    it('refuses to delete the default provider', async () => {
        mockRegistry.getProviderConfig.mockReturnValue(makeConfig({ isDefault: true }));

        const res = await createApp().handle(del('/providers/default'));

        expect(res.status).toBe(400);
        expect(mockRegistry.removeProvider).not.toHaveBeenCalled();
    });

    it('maps other failures to 400', async () => {
        mockRegistry.removeProvider.mockImplementation(() =>
            Promise.reject(new Error('redis down')),
        );

        const res = await createApp().handle(del('/providers/backup'));
        const body = (await res.json()) as { error: string };

        expect(res.status).toBe(400);
        expect(body.error).toBe('redis down');
    });

    it('rejects an unauthenticated delete', async () => {
        const res = await createApp().handle(
            new Request('http://localhost/providers/backup', { method: 'DELETE' }),
        );

        expect(res.status).toBe(401);
        expect(mockRegistry.removeProvider).not.toHaveBeenCalled();
    });
});
