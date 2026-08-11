// Shared configuration constants for Bolter

// Size constants in bytes
export const BYTES = {
    KB: 1000,
    MB: 1000 * 1000,
    GB: 1000 * 1000 * 1000,
    TB: 1000 * 1000 * 1000 * 1000,
} as const;

// Upload limits
export const UPLOAD_LIMITS = {
    MAX_FILE_SIZE: 1 * BYTES.TB, // 1TB max file size
    MULTIPART_THRESHOLD: 100 * BYTES.MB, // Use multipart for files > 100MB
    DEFAULT_PART_SIZE: 200 * BYTES.MB, // 200MB per part (increased for 1TB support)
    MAX_PART_SIZE: 5 * BYTES.GB, // 5GB per part (R2/S3 limit)
    MIN_PART_SIZE: 5 * 1024 * 1024, // 5 MiB (5,242,880) — S3/R2 enforce MiB for non-trailing parts, not decimal MB
    MAX_PARTS: 10000, // Cloudflare R2 limit
    MAX_FILES_PER_ARCHIVE: 1000,
    /**
     * Cap on the base64 metadata blob a client may attach at
     * `/upload/complete`. This — not the file count — is the resource the
     * archive limit was standing in for: the blob is stored in Redis and
     * re-served by `/metadata/:id` on every download-page load, and it is the
     * only bound that also applies to encrypted shares, whose ciphertext
     * metadata `MAX_FILES_PER_ARCHIVE` cannot inspect. 1,000 entries with
     * 255-char names encode to roughly 420KB, so 512KiB clears the file limit
     * above with room to spare.
     */
    MAX_METADATA_BYTES: 512 * 1024,
    /**
     * Global request-body ceiling. File bytes go straight to S3, so the API
     * only ever receives JSON; the largest legitimate body is an
     * `/upload/complete` carrying MAX_PARTS ETags (~600KB) plus metadata.
     * Bun defaults to 128MB, which any unauthenticated caller could send.
     */
    MAX_REQUEST_BODY_BYTES: 4 * 1024 * 1024,
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

// Part size tiers based on observed upload speed
// Slower connections use smaller parts to reduce wasted bandwidth on retries
export const PART_SIZE_TIERS = [
    { minSpeed: 50 * BYTES.MB, partSize: 200 * BYTES.MB }, // ≥50 MB/s
    { minSpeed: 10 * BYTES.MB, partSize: 100 * BYTES.MB }, // 10-50 MB/s
    { minSpeed: 2 * BYTES.MB, partSize: 50 * BYTES.MB }, // 2-10 MB/s
    { minSpeed: 0, partSize: 25 * BYTES.MB }, // <2 MB/s
] as const;

// UI defaults
export const UI_DEFAULTS = {
    TITLE: 'Slingshot Send',
    DESCRIPTION: 'Encrypt and send files with a link that automatically expires.',
} as const;
