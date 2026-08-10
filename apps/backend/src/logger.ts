import pino from 'pino';
import { config } from './config';

// Fields that must never reach the log sink. pino runs at `info` in production,
// so a single stray log object hands log-read access real authority:
//   - `owner` is the deletion/params token for a file
//   - `uploadToken` authorizes abort/resume of an in-flight upload
//   - any pre-signed S3 URL carries a valid AWS signature in its query string,
//     i.e. PUT/GET rights on the object for the URL's whole validity window
// Redaction is defense-in-depth — call sites must not log these at all — but it
// closes the gap for future call sites added without that context.
const SECRET_LOG_FIELDS = [
    'owner',
    'authKey',
    'uploadToken',
    'uploadAuth',
    'url',
    'uploadUrl',
    'fullUrl',
    'urlPreview',
    'testUrlPreview',
    'firstPartUrl',
    'secretAccessKey',
    'accessKeyId',
];

// Top-level plus one nested level (log objects here are flat or one deep)
export const redactPaths: string[] = SECRET_LOG_FIELDS.flatMap((field) => [field, `*.${field}`]);

export const logger = pino({
    level: config.env === 'development' ? 'debug' : 'info',
    redact: { paths: redactPaths, censor: '[redacted]' },
    transport:
        config.env === 'development'
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
export const providerLogger = logger.child({ module: 'provider' });
export const plausibleLogger = logger.child({ module: 'plausible' });
export const reaperLogger = logger.child({ module: 'reaper' });
