/**
 * Lifetime of the pre-signed URL behind `/download/direct/:id`.
 *
 * That route spends the download credit *before* it redirects, because a
 * native browser download never tells the page when it finished. From then on
 * the signed URL is the only thing standing between the user and the bytes,
 * and the browser's own resume-after-drop re-requests that exact URL with a
 * `Range` header. A URL that expired mid-transfer turns the resume into a 403
 * — credit gone, nothing delivered. A flat hour was wrong for anything that
 * takes longer than an hour to download, which at consumer uplinks is every
 * multi-gigabyte file.
 *
 * So the lifetime is derived from the file size: the time a full transfer takes
 * at a deliberately pessimistic floor throughput, plus a margin for the drop
 * itself, clamped to SigV4's ceiling. Over-signing costs nothing here — the
 * object id is already public via the share link, the credit is already spent,
 * and the object is deleted at the file's own expiry regardless of what the
 * signature says — while under-signing is the failure this exists to remove.
 *
 * `/download/url/:id` deliberately keeps the default hour: that path is read
 * by our own resilient stream, which refreshes the URL on a 403.
 */

/** Floor: ~2 Mbit/s. Slower than most, so the URL outlives the transfer. */
export const DIRECT_URL_FLOOR_THROUGHPUT_BPS = 256 * 1024;

/** Slack for the drop and for the browser's resume back-off. */
export const DIRECT_URL_MARGIN_SECONDS = 3600;

/** Never sign for less than the old flat hour. */
export const DIRECT_URL_MIN_LIFETIME_SECONDS = 3600;

/** SigV4 ceiling for a pre-signed URL, on S3 and R2 alike: seven days. */
export const DIRECT_URL_MAX_LIFETIME_SECONDS = 7 * 24 * 3600;

export function directDownloadUrlLifetime(fileSize: number): number {
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return DIRECT_URL_MIN_LIFETIME_SECONDS;
    }
    const transferSeconds = Math.ceil(fileSize / DIRECT_URL_FLOOR_THROUGHPUT_BPS);
    const lifetime = transferSeconds + DIRECT_URL_MARGIN_SECONDS;
    return Math.min(
        DIRECT_URL_MAX_LIFETIME_SECONDS,
        Math.max(DIRECT_URL_MIN_LIFETIME_SECONDS, lifetime),
    );
}
