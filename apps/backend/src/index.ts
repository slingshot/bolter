import * as Sentry from '@sentry/bun';

Sentry.init({
    dsn: 'https://00f833cbba29efddfb9f8fe04eb9c5a6@glitch.slingshot.fm/6',
    // Tracing
    tracesSampleRate: 1.0,
});

import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { Elysia, t } from 'elysia';
import { config } from './config';
import { captureError } from './lib/sentry';
import { logger } from './logger';
import { downloadRoutes } from './routes/download';
import { plausibleRoutes } from './routes/plausible';
import { uploadRoutes } from './routes/upload';
import { storage } from './storage';

const app = new Elysia()
    // Request logging
    .onRequest(({ request }) => {
        const url = new URL(request.url);
        logger.info(
            {
                method: request.method,
                path: url.pathname,
                query: url.search,
            },
            'Incoming request',
        );
    })

    .onAfterResponse(({ request, set }) => {
        const url = new URL(request.url);
        logger.info(
            {
                method: request.method,
                path: url.pathname,
                status: set.status || 200,
            },
            'Request completed',
        );
    })

    // Enable CORS for frontend
    .use(
        cors({
            origin: config.env === 'development' ? true : config.baseUrl,
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposeHeaders: ['WWW-Authenticate'],
        }),
    )

    // OpenAPI documentation (Scalar UI)
    .use(
        openapi({
            path: '/',
            specPath: '/openapi.json',
            documentation: {
                info: {
                    title: 'Bolter API',
                    version: '1.0.0',
                    description:
                        'File sharing API with optional end-to-end encryption. Supports files up to 1TB via multipart uploads to S3/Cloudflare R2.',
                },
                tags: [
                    { name: 'Health', description: 'Server health and readiness probes' },
                    { name: 'Configuration', description: 'Client configuration and server info' },
                    {
                        name: 'Upload',
                        description:
                            'File upload orchestration — pre-signed URLs, multipart management, completion',
                    },
                    {
                        name: 'Speed Test',
                        description: 'Upload speed measurement for adaptive part sizing',
                    },
                    {
                        name: 'Download',
                        description: 'File download, streaming, and metadata retrieval',
                    },
                    {
                        name: 'File Management',
                        description:
                            'Owner-only file operations — delete, update limits, set password',
                    },
                ],
            },
            exclude: {
                methods: ['OPTIONS'],
            },
        }),
    )

    // Health check endpoints
    .get(
        '/__heartbeat__',
        async () => {
            const health = await storage.ping();
            logger.debug({ health }, 'Health check');
            return {
                status: health.redis && health.s3 ? 'ok' : 'error',
                redis: health.redis,
                s3: health.s3,
            };
        },
        {
            detail: {
                tags: ['Health'],
                summary: 'Internal heartbeat',
                description:
                    'Quick health check for monitoring systems. Returns Redis and S3 connectivity status.',
            },
            response: t.Object({
                status: t.String(),
                redis: t.Boolean(),
                s3: t.Boolean(),
            }),
        },
    )

    .get(
        '/__version__',
        () => ({
            version: '1.0.0',
            name: 'bolter-backend',
        }),
        {
            detail: {
                tags: ['Health'],
                summary: 'Server version',
                description: 'Returns the server version and application name.',
            },
            response: t.Object({
                version: t.String(),
                name: t.String(),
            }),
        },
    )

    // Health check endpoints (Docker/K8s compatible)
    .get(
        '/health',
        async ({ set }) => {
            const health = await storage.ping();
            const isHealthy = health.redis && health.s3;
            if (!isHealthy) {
                set.status = 503;
            }
            return {
                status: isHealthy ? 'healthy' : 'unhealthy',
                timestamp: new Date().toISOString(),
                checks: {
                    redis: health.redis ? 'up' : 'down',
                    s3: health.s3 ? 'up' : 'down',
                },
            };
        },
        {
            detail: {
                tags: ['Health'],
                summary: 'Full health check',
                description:
                    'Comprehensive health check verifying Redis and S3 connectivity. Returns 503 if any dependency is down. Compatible with Docker and Kubernetes health probes.',
            },
            response: {
                200: t.Object({
                    status: t.String(),
                    timestamp: t.String(),
                    checks: t.Object({
                        redis: t.String(),
                        s3: t.String(),
                    }),
                }),
                503: t.Object({
                    status: t.String(),
                    timestamp: t.String(),
                    checks: t.Object({
                        redis: t.String(),
                        s3: t.String(),
                    }),
                }),
            },
        },
    )

    .get(
        '/health/live',
        () => ({
            status: 'alive',
            timestamp: new Date().toISOString(),
        }),
        {
            detail: {
                tags: ['Health'],
                summary: 'Liveness probe',
                description:
                    'Lightweight liveness check. Always returns 200 if the server process is running.',
            },
            response: t.Object({
                status: t.String(),
                timestamp: t.String(),
            }),
        },
    )

    .get(
        '/health/ready',
        async ({ set }) => {
            const health = await storage.ping();
            const isReady = health.redis && health.s3;
            if (!isReady) {
                set.status = 503;
            }
            return {
                status: isReady ? 'ready' : 'not_ready',
                timestamp: new Date().toISOString(),
                checks: {
                    redis: health.redis ? 'up' : 'down',
                    s3: health.s3 ? 'up' : 'down',
                },
            };
        },
        {
            detail: {
                tags: ['Health'],
                summary: 'Readiness probe',
                description:
                    'Readiness check verifying all dependencies are connected. Returns 503 if Redis or S3 is unavailable. Used by orchestrators to determine if the server can accept traffic.',
            },
            response: {
                200: t.Object({
                    status: t.String(),
                    timestamp: t.String(),
                    checks: t.Object({
                        redis: t.String(),
                        s3: t.String(),
                    }),
                }),
                503: t.Object({
                    status: t.String(),
                    timestamp: t.String(),
                    checks: t.Object({
                        redis: t.String(),
                        s3: t.String(),
                    }),
                }),
            },
        },
    )

    // Disallow all crawlers for API
    .get(
        '/robots.txt',
        ({ set }) => {
            set.headers['content-type'] = 'text/plain';
            return 'User-agent: *\nDisallow: /';
        },
        {
            detail: { hide: true },
        },
    )

    // Client configuration
    .get(
        '/config',
        () => ({
            LIMITS: {
                MAX_FILE_SIZE: config.maxFileSize,
                MAX_FILES_PER_ARCHIVE: config.maxFilesPerArchive,
                MAX_EXPIRE_SECONDS: config.maxExpireSeconds,
                MAX_DOWNLOADS: config.maxDownloads,
            },
            DEFAULTS: {
                EXPIRE_SECONDS: config.defaultExpireSeconds,
                DOWNLOADS: config.defaultDownloads,
            },
            UI: {
                TITLE: config.customTitle,
                DESCRIPTION: config.customDescription,
                EXPIRE_TIMES: config.expireTimesSeconds,
                DOWNLOAD_COUNTS: config.downloadCounts,
            },
        }),
        {
            detail: {
                tags: ['Configuration'],
                summary: 'Client configuration',
                description:
                    'Returns server-configured limits, defaults, and UI settings for the frontend client.',
            },
            response: t.Object({
                LIMITS: t.Object({
                    MAX_FILE_SIZE: t.Number(),
                    MAX_FILES_PER_ARCHIVE: t.Number(),
                    MAX_EXPIRE_SECONDS: t.Number(),
                    MAX_DOWNLOADS: t.Number(),
                }),
                DEFAULTS: t.Object({
                    EXPIRE_SECONDS: t.Number(),
                    DOWNLOADS: t.Number(),
                }),
                UI: t.Object({
                    TITLE: t.String(),
                    DESCRIPTION: t.String(),
                    EXPIRE_TIMES: t.Array(t.Number()),
                    DOWNLOAD_COUNTS: t.Array(t.Number()),
                }),
            }),
        },
    )

    // Mount API routes
    .use(uploadRoutes)
    .use(downloadRoutes)
    .use(plausibleRoutes)

    // Error handling
    .onError(({ code, error, set, request }) => {
        const url = new URL(request.url);

        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;

        logger.error(
            {
                code,
                error: errorMessage,
                stack: errorStack,
            },
            'Server error',
        );

        if (code === 'NOT_FOUND') {
            set.status = 404;
            return { error: 'Not found' };
        }

        if (code === 'VALIDATION') {
            set.status = 400;
            return { error: 'Invalid request', details: error.message };
        }

        captureError(error, {
            operation: 'server.unhandled',
            tags: {
                errorCode: code.toString(),
                method: request.method,
                path: url.pathname,
            },
            extra: {
                query: url.search,
                statusCode: 500,
            },
        });

        set.status = 500;
        return { error: 'Internal server error' };
    })

    // Start server
    .listen(config.port);

logger.info(
    {
        port: config.port,
        env: config.env,
        s3Endpoint: config.s3Endpoint,
        s3Bucket: config.s3Bucket,
        s3PathStyle: config.s3UsePathStyle,
    },
    'Server starting',
);

console.log(`
  ╔══════════════════════════════════════╗
  ║        Bolter Backend Server         ║
  ╠══════════════════════════════════════╣
  ║  Running on: http://localhost:${config.port}   ║
  ║  Environment: ${config.env.padEnd(18)}  ║
  ╚══════════════════════════════════════╝
`);

// Connect to Redis
storage.redis
    .connect()
    .then(() => {
        logger.info('Connected to Redis');
        console.log('Connected to Redis');
    })
    .catch((err) => {
        captureError(err, { operation: 'redis.connect' });
        logger.error({ error: err }, 'Failed to connect to Redis');
        console.error('Failed to connect to Redis:', err);
    });

export type App = typeof app;
