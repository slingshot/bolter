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

// Connect to Redis and initialize provider registry
storage.redis
    .connect()
    .then(async () => {
        logger.info('Connected to Redis');
        console.log('Connected to Redis');

        await providerRegistry.initialize();
        logger.info('Provider registry initialized');
        console.log('Provider registry initialized');
    })
    .catch((err) => {
        captureError(err, { operation: 'redis.connect' });
        logger.error({ error: err }, 'Failed to connect to Redis');
        console.error('Failed to connect to Redis:', err);
    });

export type { App } from './app';
