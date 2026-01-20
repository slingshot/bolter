import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.env === 'development' ? 'debug' : 'info',
  transport: config.env === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

// Child loggers for different modules
export const s3Logger = logger.child({ module: 's3' });
export const uploadLogger = logger.child({ module: 'upload' });
export const downloadLogger = logger.child({ module: 'download' });
export const storageLogger = logger.child({ module: 'storage' });
