// Configuration for Bolter backend

export interface Config {
  // S3 Configuration
  s3Bucket: string;
  s3Endpoint: string;
  s3UsePathStyle: boolean;

  // Redis Configuration
  redisHost: string;
  redisPort: number;
  redisPassword: string;
  redisUser: string;

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
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || '',
  redisUser: process.env.REDIS_USER || '',

  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  baseUrl: process.env.BASE_URL || 'http://localhost:3001',
  env: (process.env.NODE_ENV as Config['env']) || 'development',

  // Limits
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || String(1024 * 1024 * 1024 * 2.5), 10), // 2.5GB
  maxFilesPerArchive: parseInt(process.env.MAX_FILES_PER_ARCHIVE || '64', 10),
  maxExpireSeconds: parseInt(process.env.MAX_EXPIRE_SECONDS || String(86400 * 7), 10), // 7 days
  maxDownloads: parseInt(process.env.MAX_DOWNLOADS || '100', 10),

  // Defaults
  defaultExpireSeconds: parseInt(process.env.DEFAULT_EXPIRE_SECONDS || '86400', 10), // 1 day
  defaultDownloads: parseInt(process.env.DEFAULT_DOWNLOADS || '1', 10),
  expireTimesSeconds: parseIntArray(process.env.EXPIRE_TIMES_SECONDS, [300, 3600, 86400, 604800]),
  downloadCounts: parseIntArray(process.env.DOWNLOAD_COUNTS, [1, 2, 3, 4, 5, 20, 50, 100]),

  // UI
  customTitle: process.env.CUSTOM_TITLE || 'Bolter',
  customDescription: process.env.CUSTOM_DESCRIPTION || 'Encrypt and send files with a link that automatically expires.',
};

export function deriveBaseUrl(request: Request): string {
  if (process.env.DETECT_BASE_URL === 'true') {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  }
  return config.baseUrl;
}
