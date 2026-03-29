import { Elysia, t } from 'elysia';
import { config } from '../config';
import { providerLogger as logger } from '../logger';
import { providerRegistry } from '../storage/provider-registry';

const adminAuth = (headers: Record<string, string | undefined>) => {
    if (!config.adminApiKey) {
        return {
            ok: false as const,
            error: 'Provider management not configured (ADMIN_API_KEY not set)',
            status: 503,
        };
    }
    const auth = headers.authorization;
    if (auth !== `Bearer ${config.adminApiKey}`) {
        return { ok: false as const, error: 'Unauthorized', status: 401 };
    }
    return { ok: true as const };
};

export const providerRoutes = new Elysia({ prefix: '/providers' })
    // List all providers
    .get(
        '/',
        ({ headers, set }) => {
            const auth = adminAuth(headers);
            if (!auth.ok) {
                set.status = auth.status;
                return { error: auth.error };
            }

            const providers = providerRegistry.listProviders();
            return { providers };
        },
        {
            detail: {
                tags: ['Storage Providers'],
                summary: 'List all storage providers',
                description:
                    'Returns all registered S3-compatible storage providers with secrets masked.',
            },
        },
    )

    // Get single provider
    .get(
        '/:id',
        ({ params, headers, set }) => {
            const auth = adminAuth(headers);
            if (!auth.ok) {
                set.status = auth.status;
                return { error: auth.error };
            }

            const provider = providerRegistry.getProviderPublic(params.id);
            if (!provider) {
                set.status = 404;
                return { error: 'Provider not found' };
            }
            return { provider };
        },
        {
            detail: {
                tags: ['Storage Providers'],
                summary: 'Get storage provider',
                description: 'Returns details for a specific storage provider with secrets masked.',
            },
        },
    )

    // Add a new provider
    .post(
        '/',
        async ({ body, headers, set }) => {
            const auth = adminAuth(headers);
            if (!auth.ok) {
                set.status = auth.status;
                return { error: auth.error };
            }

            try {
                const provider = await providerRegistry.addProvider(body);
                logger.info(
                    { providerId: provider.id, name: provider.name },
                    'Provider created via API',
                );
                set.status = 201;
                return {
                    provider: {
                        ...provider,
                        accessKeyId:
                            provider.accessKeyId.slice(0, 4) +
                            '****' +
                            provider.accessKeyId.slice(-4),
                        secretAccessKey: undefined,
                    },
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Failed to add provider';
                logger.error({ error: e }, 'Failed to add provider');
                set.status = 400;
                return { error: message };
            }
        },
        {
            detail: {
                tags: ['Storage Providers'],
                summary: 'Add storage provider',
                description:
                    'Registers a new S3-compatible storage provider. Validates connectivity by pinging the bucket before saving.',
            },
            body: t.Object({
                name: t.String(),
                bucket: t.String(),
                endpoint: t.String(),
                accessKeyId: t.String(),
                secretAccessKey: t.String(),
                region: t.Optional(t.String()),
                pathStyle: t.Optional(t.Boolean()),
                isActive: t.Optional(t.Boolean()),
            }),
        },
    )

    // Update a provider
    .put(
        '/:id',
        async ({ params, body, headers, set }) => {
            const auth = adminAuth(headers);
            if (!auth.ok) {
                set.status = auth.status;
                return { error: auth.error };
            }

            try {
                const provider = await providerRegistry.updateProvider(params.id, body);
                logger.info({ providerId: provider.id }, 'Provider updated via API');
                return {
                    provider: {
                        ...provider,
                        accessKeyId:
                            provider.accessKeyId.slice(0, 4) +
                            '****' +
                            provider.accessKeyId.slice(-4),
                        secretAccessKey: undefined,
                    },
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Failed to update provider';
                set.status = 400;
                return { error: message };
            }
        },
        {
            detail: {
                tags: ['Storage Providers'],
                summary: 'Update storage provider',
                description:
                    'Updates configuration for an existing storage provider. Cannot change the default flag.',
            },
            body: t.Object({
                name: t.Optional(t.String()),
                bucket: t.Optional(t.String()),
                endpoint: t.Optional(t.String()),
                accessKeyId: t.Optional(t.String()),
                secretAccessKey: t.Optional(t.String()),
                region: t.Optional(t.String()),
                pathStyle: t.Optional(t.Boolean()),
                isActive: t.Optional(t.Boolean()),
            }),
        },
    )

    // Delete a provider
    .delete(
        '/:id',
        async ({ params, headers, set, query }) => {
            const auth = adminAuth(headers);
            if (!auth.ok) {
                set.status = auth.status;
                return { error: auth.error };
            }

            try {
                // Check if provider is the default
                const cfg = providerRegistry.getProviderConfig(params.id);
                if (!cfg) {
                    set.status = 404;
                    return { error: 'Provider not found' };
                }
                if (cfg.isDefault) {
                    set.status = 400;
                    return { error: 'Cannot delete the default provider' };
                }

                const fileCount = await providerRegistry.getFileCount(params.id);
                if (fileCount > 0 && query.force !== 'true') {
                    set.status = 409;
                    return {
                        error: `Cannot delete provider "${params.id}" — ${fileCount} active file(s) still reference it. Use ?force=true to override.`,
                    };
                }

                await providerRegistry.removeProvider(params.id);
                logger.info({ providerId: params.id }, 'Provider deleted via API');
                return { success: true };
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Failed to delete provider';
                set.status = 400;
                return { error: message };
            }
        },
        {
            detail: {
                tags: ['Storage Providers'],
                summary: 'Delete storage provider',
                description:
                    'Removes a storage provider. Cannot delete the default or a provider with active files (unless ?force=true).',
            },
            query: t.Object({
                force: t.Optional(t.String()),
            }),
        },
    )

    // Ping a specific provider
    .post(
        '/:id/ping',
        async ({ params, headers, set }) => {
            const auth = adminAuth(headers);
            if (!auth.ok) {
                set.status = auth.status;
                return { error: auth.error };
            }

            try {
                const result = await providerRegistry.healthCheckProvider(params.id);
                return result;
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Health check failed';
                set.status = 404;
                return { error: message };
            }
        },
        {
            detail: {
                tags: ['Storage Providers'],
                summary: 'Ping storage provider',
                description: 'Health-checks a specific storage provider by pinging its S3 bucket.',
            },
        },
    )

    // Activate a provider
    .post(
        '/:id/activate',
        async ({ params, headers, set }) => {
            const auth = adminAuth(headers);
            if (!auth.ok) {
                set.status = auth.status;
                return { error: auth.error };
            }

            try {
                const provider = await providerRegistry.activateProvider(params.id);
                logger.info({ providerId: provider.id }, 'Provider activated via API');
                return {
                    provider: {
                        ...provider,
                        accessKeyId:
                            provider.accessKeyId.slice(0, 4) +
                            '****' +
                            provider.accessKeyId.slice(-4),
                        secretAccessKey: undefined,
                    },
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Failed to activate provider';
                set.status = 400;
                return { error: message };
            }
        },
        {
            detail: {
                tags: ['Storage Providers'],
                summary: 'Activate storage provider',
                description:
                    'Sets a provider as the active upload target. Deactivates all other providers.',
            },
        },
    );
