import { config } from '../config';

/**
 * Clamp a client-supplied download limit to a usable positive integer within
 * the deployment's `MAX_DOWNLOADS`.
 *
 * Stored verbatim, a hostile `dlimit` breaks every `dl >= dlimit` gate: a huge
 * value makes the limit unreachable (unlimited egress), a negative or zero
 * value bricks the file instantly, and a float round-trips through Redis as an
 * exponential string that `parseInt` reads back as a different number
 * (`1e21` -> `'1e+21'` -> `1`). Truncating and clamping keeps the stored value
 * a small decimal integer that always survives the round-trip.
 */
export function clampDownloadLimit(dlimit: number): number {
    if (!Number.isFinite(dlimit)) {
        return config.defaultDownloads;
    }
    return Math.min(Math.max(Math.trunc(dlimit), 1), config.maxDownloads);
}
