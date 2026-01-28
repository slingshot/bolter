// Shared configuration constants for Bolter

// Size constants in bytes
export const BYTES = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024,
} as const;

// Encryption constants for ECE (Encrypted Content Encoding)
export const ECE_CONSTANTS = {
  RECORD_SIZE: 64 * BYTES.KB, // 64KB plaintext record size
  TAG_LENGTH: 16, // AES-GCM tag length
  DELIMITER_LENGTH: 1, // Delimiter byte per record
  // Encrypted record size = plaintext + tag + delimiter
  ENCRYPTED_RECORD_SIZE: 64 * BYTES.KB + 16 + 1, // 65,553 bytes
} as const;

// Upload limits
export const UPLOAD_LIMITS = {
  MAX_FILE_SIZE: 1 * BYTES.TB, // 1TB max file size
  MULTIPART_THRESHOLD: 100 * BYTES.MB, // Use multipart for files > 100MB
  // Part size aligned to encryption record boundaries for resumability
  // ~200MB = 3,052 records × 65,553 bytes = 200,067,756 bytes
  DEFAULT_PART_SIZE: Math.floor(200 * BYTES.MB / ECE_CONSTANTS.ENCRYPTED_RECORD_SIZE) * ECE_CONSTANTS.ENCRYPTED_RECORD_SIZE,
  MAX_PART_SIZE: 5 * BYTES.GB, // 5GB per part (R2/S3 limit)
  MAX_PARTS: 10000, // Cloudflare R2 limit
  MAX_FILES_PER_ARCHIVE: 64,
  // Resumable upload session expiry (matches R2 multipart lifecycle)
  SESSION_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
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
