import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { config } from './config';
import { storage } from './storage';
import { uploadRoutes } from './routes/upload';
import { downloadRoutes } from './routes/download';

const app = new Elysia()
  // Enable CORS for frontend
  .use(cors({
    origin: config.env === 'development' ? true : config.baseUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['WWW-Authenticate'],
  }))

  // Health check endpoints
  .get('/__heartbeat__', async () => {
    const health = await storage.ping();
    return {
      status: health.redis && health.s3 ? 'ok' : 'error',
      redis: health.redis,
      s3: health.s3,
    };
  })

  .get('/__version__', () => ({
    version: '1.0.0',
    name: 'bolter-backend',
  }))

  // Client configuration
  .get('/config', () => ({
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
  }))

  // Mount API routes
  .use(uploadRoutes)
  .use(downloadRoutes)

  // Error handling
  .onError(({ code, error, set }) => {
    console.error('Server error:', { code, error: error.message });

    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { error: 'Not found' };
    }

    if (code === 'VALIDATION') {
      set.status = 400;
      return { error: 'Invalid request', details: error.message };
    }

    set.status = 500;
    return { error: 'Internal server error' };
  })

  // Start server
  .listen(config.port);

console.log(`
  ╔══════════════════════════════════════╗
  ║        Bolter Backend Server         ║
  ╠══════════════════════════════════════╣
  ║  Running on: http://localhost:${config.port}   ║
  ║  Environment: ${config.env.padEnd(18)}  ║
  ╚══════════════════════════════════════╝
`);

// Connect to Redis
storage.redis.connect().then(() => {
  console.log('Connected to Redis');
}).catch((err) => {
  console.error('Failed to connect to Redis:', err);
});

export type App = typeof app;
