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

/**
 * Multipart part sizing, derived from file size alone.
 *
 * R2 requires every non-trailing part to be the same size (error 10048), so
 * part size is decided once at allocation and can never adapt mid-upload —
 * which is why measuring the client's bandwidth first was never worth its
 * cost. Two facts set the bounds:
 *
 * - Writes per second against one object key equal `throughput / partSize`,
 *   independent of concurrency. R2 documents a 1 write/sec/key limit; whether
 *   it covers UploadPart is not stated, so FLOOR buys headroom (~1.5/sec even
 *   on a 100 MB/s link) rather than betting on the permissive reading.
 * - MAX_PARTS is 10,000. CEILING keeps the 1TB worst case at 7,451 parts.
 */
export const PART_SIZING = {
    /** Aim for ~1000 parts; FLOOR and CEILING override this at both ends. */
    TARGET_PART_COUNT: 1000,
    FLOOR: 64 * 1024 * 1024,
    CEILING: 128 * 1024 * 1024,
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
    DEFAULT_DOWNLOADS: 5,
    DOWNLOAD_COUNTS: [1, 2, 3, 4, 5, 20, 50, 100],
} as const;

// UI defaults
export const UI_DEFAULTS = {
    TITLE: 'Slingshot Send',
    DESCRIPTION: 'Encrypt and send files with a link that automatically expires.',
} as const;
