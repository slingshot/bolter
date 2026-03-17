/**
 * Terminal progress bar for upload/download operations.
 * Renders to stderr to keep stdout clean for piping/JSON output.
 */

import { formatBytes, formatDuration, formatSpeed } from './format';

export class ProgressBar {
    private total: number;
    private label: string;
    private lastRender = 0;
    private completed = false;
    private labelPrinted = false;

    constructor(label: string, total: number) {
        this.label = label;
        this.total = total;
    }

    /** Update progress — renders at most once per 100ms */
    update(loaded: number, speed: number, eta: number): void {
        if (this.completed) {
            return;
        }

        const now = Date.now();
        if (now - this.lastRender < 100) {
            return;
        }
        this.lastRender = now;

        // Print label line once on first update
        if (!this.labelPrinted) {
            process.stderr.write(`${this.label} (${formatBytes(this.total)})\n`);
            this.labelPrinted = true;
        }

        const cols = process.stderr.columns || 80;
        const pct = Math.min(loaded / this.total, 1);
        const pctStr = `${Math.round(pct * 100)}%`;

        // Build the stats portion: " 64% | 768 MB / 1.2 GB | 45.2 MB/s | ETA 10s"
        const stats = ` ${pctStr} \u2502 ${formatBytes(loaded)} / ${formatBytes(this.total)} \u2502 ${formatSpeed(speed)} \u2502 ETA ${formatDuration(eta)}`;

        // Prefix is "  " (2-space indent)
        const prefix = '  ';

        // Calculate bar width: total line - prefix - stats - 1 (space between bar and stats)
        const barWidth = Math.max(10, cols - prefix.length - stats.length - 1);
        const filledCount = Math.round(pct * barWidth);
        const emptyCount = barWidth - filledCount;

        const bar = '\u2588'.repeat(filledCount) + '\u2591'.repeat(emptyCount);

        // Green bar, yellow stats, reset
        const line = `${prefix}\x1b[32m${bar}\x1b[0m\x1b[33m${stats}\x1b[0m`;

        process.stderr.write(`\r${line}`);
    }

    /** Mark as complete with a success message */
    finish(message: string): void {
        if (this.completed) {
            return;
        }
        this.completed = true;
        this.clear();
        process.stderr.write(`\x1b[32m\u2714\x1b[0m ${message}\n`);
    }

    /** Clear the progress line */
    clear(): void {
        const cols = process.stderr.columns || 80;
        process.stderr.write(`\r${' '.repeat(cols)}\r`);
    }
}

/**
 * Helper to create a progress bar with a matching callback
 */
export function createProgressCallback(
    label: string,
    total: number,
): {
    bar: ProgressBar;
    onProgress: (p: { loaded: number; speed: number; eta: number }) => void;
} {
    const bar = new ProgressBar(label, total);
    return {
        bar,
        onProgress: (p) => bar.update(p.loaded, p.speed, p.eta),
    };
}
