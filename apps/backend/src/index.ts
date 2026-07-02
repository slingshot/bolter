import * as Sentry from '@sentry/bun';

Sentry.init({
    dsn: 'https://00f833cbba29efddfb9f8fe04eb9c5a6@glitch.slingshot.fm/6',
    // Tracing
    tracesSampleRate: 1.0,
});

import { app } from './app';
import { config } from './config';
import { captureError } from './lib/sentry';
import { logger } from './logger';
import { storage } from './storage';
import { providerRegistry } from './storage/provider-registry';

// Connect to Redis and initialize the provider registry BEFORE accepting
// traffic — a listening server with no storage backend would serve only errors
try {
    await storage.redis.connect();
    logger.info('Connected to Redis');
    console.log('Connected to Redis');
} catch (err) {
    captureError(err, { operation: 'redis.connect' });
    logger.error({ error: err }, 'Failed to connect to Redis');
    console.error('Failed to connect to Redis:', err);
    process.exit(1);
}

try {
    await providerRegistry.initialize();
    logger.info('Provider registry initialized');
    console.log('Provider registry initialized');
} catch (err) {
    captureError(err, { operation: 'provider-registry.initialize' });
    logger.error({ error: err }, 'Failed to initialize provider registry');
    console.error('Failed to initialize provider registry:', err);
    process.exit(1);
}

// Start server
app.listen(config.port);

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

export type { App } from './app';
