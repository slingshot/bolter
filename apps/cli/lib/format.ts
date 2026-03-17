/**
 * Formatting helpers for bytes, durations, and duration parsing
 */

/**
 * Format bytes into human-readable string
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1000;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const value = bytes / k ** i;
    // Use integer for values >= 100, one decimal for >= 10, two decimals otherwise
    const formatted =
        value >= 100
            ? Math.round(value).toString()
            : value >= 10
              ? value.toFixed(1)
              : value.toFixed(2);
    return `${formatted} ${units[i]}`;
}

/**
 * Format seconds into human-readable duration
 */
export function formatDuration(seconds: number): string {
    if (seconds < 1) {
        return '<1s';
    }
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    }
    if (seconds < 3600) {
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    if (seconds < 86400) {
        const h = Math.floor(seconds / 3600);
        const m = Math.round((seconds % 3600) / 60);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(seconds / 86400);
    const h = Math.round((seconds % 86400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Duration string aliases for the --expire flag.
 * "m" always means minutes. Use "mo" for months to avoid ambiguity.
 */
const DURATION_MAP: Record<string, number> = {
    '5m': 300,
    '1h': 3600,
    '1d': 86400,
    '7d': 604800,
    '14d': 1209600,
    '30d': 2592000,
    '3mo': 7776000,
    '6mo': 15552000,
};

/**
 * Parse a duration string into seconds.
 * Supported formats: Ns (seconds), Nm (minutes), Nh (hours), Nd (days), Nmo (months of 30 days)
 * Examples: "5m", "1h", "7d", "3mo", "6mo"
 */
export function parseDuration(str: string): number | null {
    const lower = str.toLowerCase().trim();

    // Check known aliases first
    if (DURATION_MAP[lower] !== undefined) {
        return DURATION_MAP[lower];
    }

    // Try parsing generic patterns: Nmo (months), Nd, Nh, Nm, Ns
    const moMatch = lower.match(/^(\d+)\s*mo$/);
    if (moMatch) {
        return parseInt(moMatch[1], 10) * 30 * 86400;
    }

    const match = lower.match(/^(\d+)\s*(s|m|h|d)$/);
    if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2];
        switch (unit) {
            case 's':
                return value;
            case 'm':
                return value * 60;
            case 'h':
                return value * 3600;
            case 'd':
                return value * 86400;
        }
    }

    return null;
}

/**
 * Format a speed value in bytes/second
 */
export function formatSpeed(bytesPerSecond: number): string {
    return `${formatBytes(bytesPerSecond)}/s`;
}
