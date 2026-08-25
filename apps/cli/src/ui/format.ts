/**
 * Human formatting. Pure — no colour, no stream, no terminal.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Decimal units, matching `@bolter/shared`'s BYTES and every size the server
 * reports. Showing 1 GB as 0.93 GiB against a limit expressed in GB is the
 * kind of mismatch that makes a user think they hit a bug.
 */
export function formatBytes(bytes: number, precision?: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return '—';
    }
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < UNITS.length - 1) {
        value /= 1000;
        unit++;
    }
    const digits = precision ?? (unit === 0 ? 0 : value < 10 ? 1 : value < 100 ? 1 : 0);
    return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        return '—';
    }
    return `${formatBytes(bytesPerSecond)}/s`;
}

/** Compact duration: `2m 41s`, `3h 5m`, `4d 2h`. */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '—';
    }
    const s = Math.round(seconds);
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
    }
    const h = Math.floor(m / 60);
    if (h < 24) {
        return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    }
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** `in 22h 14m` / `expired` — for a TTL the server reported in seconds. */
export function formatExpiry(ttlSeconds: number): string {
    return ttlSeconds <= 0 ? 'expired' : `in ${formatDuration(ttlSeconds)}`;
}

/**
 * A progress bar of `width` cells. Uses eighth-blocks so a bar that is barely
 * started still shows movement — at 40 cells a whole cell is 2.5%, which on a
 * multi-hour transfer would look frozen for minutes at a time.
 */
export function progressBar(fraction: number, width: number): string {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    const eighths = Math.round(clamped * width * 8);
    const full = Math.floor(eighths / 8);
    const remainder = eighths % 8;
    const partial = remainder ? '▏▎▍▌▋▊▉'[remainder - 1] : '';
    return ('█'.repeat(full) + partial).padEnd(width, '░').slice(0, width);
}

/** Left-aligned key/value block with the values lined up. */
export function keyValueLines(entries: Array<[string, string]>): string[] {
    const width = entries.reduce((n, [k]) => Math.max(n, k.length), 0);
    return entries.map(([k, v]) => `${k.padEnd(width)}  ${v}`);
}

/** Middle-truncate so both ends of a long name stay readable. */
export function truncateMiddle(text: string, max: number): string {
    if (text.length <= max || max < 4) {
        return text;
    }
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
