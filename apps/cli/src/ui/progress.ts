/**
 * One progress model, three renderers.
 *
 * The model is whatever the transfer reports; the renderer is chosen once,
 * before the first byte, from the output mode. Choosing early matters: a
 * renderer that redraws a line cannot be swapped in after something has
 * already been printed without leaving debris behind.
 */

import type { UploadProgress } from '../transfer/upload';
import { type DashboardHandle, type DashboardModel, mountDashboard } from './dashboard';
import { formatBytes, formatDuration, formatRate, progressBar, truncateMiddle } from './format';
import type { Output } from './output';

export interface ProgressReporter {
    update(progress: UploadProgress): void;
    /** Clear any transient line or tear down the dashboard. Idempotent. */
    done(): void;
}

export interface ReporterOptions {
    /** Take over the terminal with the full-screen dashboard. */
    promote?: boolean;
    encrypted?: boolean;
    /** Lines to show in the dashboard's event panel. */
    events?: Array<{ id: number; text: string }>;
}

/** Redraw no faster than this; a terminal cannot show more and it costs CPU. */
const REDRAW_INTERVAL_MS = 100;

/** How often a non-interactive renderer prints a line. */
const PLAIN_INTERVAL_MS = 5_000;

export function createProgressReporter(
    output: Output,
    label: string,
    options: ReporterOptions = {},
    write: (text: string) => void = (text) => process.stderr.write(text),
): ProgressReporter {
    if (options.promote && output.mode !== 'json') {
        return createDashboardReporter(label, options);
    }
    if (output.mode === 'json') {
        // stdout must stay a single JSON object, and stderr noise in a
        // machine-driven run is just noise.
        return { update: () => undefined, done: () => undefined };
    }

    if (output.mode === 'plain') {
        let lastAt = 0;
        return {
            update(progress) {
                const now = Date.now();
                const finished = progress.uploaded >= progress.total;
                if (!finished && now - lastAt < PLAIN_INTERVAL_MS) {
                    return;
                }
                lastAt = now;
                const percent = progress.total
                    ? Math.floor((progress.uploaded / progress.total) * 100)
                    : 0;
                // One line per interval, never a redraw: this output is going
                // to a log file or a CI transcript.
                write(
                    `${label}: ${percent}% (${formatBytes(progress.uploaded)}/${formatBytes(progress.total)}) ` +
                        `${formatRate(progress.rate)}\n`,
                );
            },
            done: () => undefined,
        };
    }

    const { theme } = output;
    let lastAt = 0;
    let dirty = false;

    const clear = () => {
        if (dirty) {
            // \u001B[2K clears the whole line; \r alone would leave the tail of a
            // longer previous frame visible.
            write('\r\u001B[2K');
            dirty = false;
        }
    };

    return {
        update(progress) {
            const now = Date.now();
            if (now - lastAt < REDRAW_INTERVAL_MS && progress.uploaded < progress.total) {
                return;
            }
            lastAt = now;

            const fraction = progress.total ? progress.uploaded / progress.total : 0;
            const width = Math.max(10, Math.min((process.stderr.columns ?? 80) - 52, 32));
            const eta = progress.eta === null ? '—' : formatDuration(progress.eta);
            const parts =
                progress.partsTotal > 1
                    ? theme.muted(` ${progress.partsDone}/${progress.partsTotal}`)
                    : '';
            const retries = progress.retries ? theme.warning(` ${progress.retries}r`) : '';

            clear();
            write(
                `\r${truncateMiddle(label, 24).padEnd(24)} ` +
                    `${progressBar(fraction, width)} ` +
                    `${String(Math.floor(fraction * 100)).padStart(3)}% ` +
                    `${theme.secondary(formatRate(progress.rate).padStart(10))} ` +
                    `${theme.muted(`eta ${eta}`)}${parts}${retries}`,
            );
            dirty = true;
        },
        done: clear,
    };
}

/**
 * The dashboard renderer.
 *
 * Mounted lazily on the first update rather than up front, so a transfer that
 * fails during allocation never draws a frame at all. Throughput samples are
 * collected once per second, which is the resolution a sparkline can show.
 */
function createDashboardReporter(label: string, options: ReporterOptions): ProgressReporter {
    let handle: DashboardHandle | undefined;
    let stopped = false;
    const samples: number[] = [];
    let lastSampleAt = 0;

    const model = (progress: UploadProgress): DashboardModel => {
        const now = Date.now();
        if (now - lastSampleAt >= 1000) {
            lastSampleAt = now;
            samples.push(progress.rate);
            if (samples.length > 120) {
                samples.shift();
            }
        }
        return {
            ...progress,
            label,
            encrypted: options.encrypted ?? false,
            samples,
            events: options.events ?? [],
        };
    };

    return {
        update(progress) {
            if (stopped) {
                return;
            }
            const next = model(progress);
            if (handle) {
                handle.update(next);
                return;
            }
            try {
                handle = mountDashboard(next);
            } catch {
                // A terminal that will not host the renderer is not a reason
                // to fail a transfer; the run simply goes quiet.
                stopped = true;
            }
        },
        done() {
            stopped = true;
            handle?.stop();
            handle = undefined;
        },
    };
}
