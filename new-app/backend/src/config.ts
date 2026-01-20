// Configuration for Bolter backend
import {
  UPLOAD_LIMITS,
  TIME_LIMITS,
  DOWNLOAD_LIMITS,
  UI_DEFAULTS,
} from '@bolter/shared';

export interface Config {
  // S3 Configuration
  s3Bucket: string;
  s3Endpoint: string;
  s3UsePathStyle: boolean;

  // Redis Configuration
  redisUrl: string;

  // Server Configuration
  port: number;
  baseUrl: string;
  env: 'development' | 'production' | 'test';

  // Limits
  maxFileSize: number;
  maxFilesPerArchive: number;
  maxExpireSeconds: number;
  maxDownloads: number;

  // Defaults
  defaultExpireSeconds: number;
  defaultDownloads: number;
  expireTimesSeconds: number[];
  downloadCounts: number[];

  // UI Configuration
  customTitle: string;
  customDescription: string;
}

function parseIntArray(value: string | undefined, defaults: number[]): number[] {
  if (!value) return defaults;
  return value.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n));
}

export const config: Config = {
  // S3
  s3Bucket: process.env.S3_BUCKET || '',
  s3Endpoint: process.env.S3_ENDPOINT || '',
  s3UsePathStyle: process.env.S3_USE_PATH_STYLE_ENDPOINT === 'true',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  baseUrl: process.env.BASE_URL || 'http://localhost:3001',
  env: (process.env.NODE_ENV as Config['env']) || 'development',

  // Limits
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || String(UPLOAD_LIMITS.MAX_FILE_SIZE), 10),
  maxFilesPerArchive: parseInt(process.env.MAX_FILES_PER_ARCHIVE || String(UPLOAD_LIMITS.MAX_FILES_PER_ARCHIVE), 10),
  maxExpireSeconds: parseInt(process.env.MAX_EXPIRE_SECONDS || String(TIME_LIMITS.MAX_EXPIRE_SECONDS), 10),
  maxDownloads: parseInt(process.env.MAX_DOWNLOADS || String(DOWNLOAD_LIMITS.MAX_DOWNLOADS), 10),

  // Defaults
  defaultExpireSeconds: parseInt(process.env.DEFAULT_EXPIRE_SECONDS || String(TIME_LIMITS.DEFAULT_EXPIRE_SECONDS), 10),
  defaultDownloads: parseInt(process.env.DEFAULT_DOWNLOADS || String(DOWNLOAD_LIMITS.DEFAULT_DOWNLOADS), 10),
  expireTimesSeconds: parseIntArray(process.env.EXPIRE_TIMES_SECONDS, [...TIME_LIMITS.EXPIRE_TIMES]),
  downloadCounts: parseIntArray(process.env.DOWNLOAD_COUNTS, [...DOWNLOAD_LIMITS.DOWNLOAD_COUNTS]),

  // UI
  customTitle: process.env.CUSTOM_TITLE || UI_DEFAULTS.TITLE,
  customDescription: process.env.CUSTOM_DESCRIPTION || UI_DEFAULTS.DESCRIPTION,
};

export function deriveBaseUrl(request: Request): string {
  if (process.env.DETECT_BASE_URL === 'true') {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  }
  return config.baseUrl;
}
