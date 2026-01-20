// Shared configuration constants for Bolter

// Size constants in bytes
export const BYTES = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024,
} as const;

// Upload limits
export const UPLOAD_LIMITS = {
  MAX_FILE_SIZE: 1 * BYTES.TB, // 1TB max file size
  MULTIPART_THRESHOLD: 100 * BYTES.MB, // Use multipart for files > 100MB
  DEFAULT_PART_SIZE: 200 * BYTES.MB, // 200MB per part (increased for 1TB support)
  MAX_PART_SIZE: 5 * BYTES.GB, // 5GB per part (R2/S3 limit)
  MAX_PARTS: 10000, // Cloudflare R2 limit
  MAX_FILES_PER_ARCHIVE: 64,
} as const;

// Time limits in seconds
export const TIME_LIMITS = {
  MAX_EXPIRE_SECONDS: 86400 * 180, // 6 months
  DEFAULT_EXPIRE_SECONDS: 86400, // 1 day
  EXPIRE_TIMES: [300, 3600, 86400, 604800, 1209600, 2592000, 7776000, 15552000],
  // 5min, 1hr, 1day, 7days, 14days, 30days, 3months, 6months
} as const;

// Download limits
export const DOWNLOAD_LIMITS = {
  MAX_DOWNLOADS: 100,
  DEFAULT_DOWNLOADS: 1,
  DOWNLOAD_COUNTS: [1, 2, 3, 4, 5, 20, 50, 100],
} as const;

// UI defaults
export const UI_DEFAULTS = {
  TITLE: 'Slingshot Send',
  DESCRIPTION: 'Encrypt and send files with a link that automatically expires.',
} as const;
