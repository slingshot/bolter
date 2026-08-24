/**
 * The full-screen transfer dashboard.
 *
 * Promoted only for a transfer long enough to be worth watching — see
 * `shouldPromote`. Alt-screen output is genuinely worse for a two-second
 * upload: it clears, redraws, and takes the terminal away from whatever else
 * was on it.
 *
 * On teardown the result is reprinted into the *normal* buffer by the caller,
 * because an alt-screen app that exits takes its contents with it. A dashboard
 * that swallows the share link it just produced would be a downgrade on
 * printing one line.
 */

import { Panel, ProgressBar, Stack } from '@bunli/tui';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import type { UploadProgress } from '../transfer/upload';
import { formatBytes, formatDuration, formatRate, truncateMiddle } from './format';

export interface DashboardModel extends UploadProgress {
    label: string;
    encrypted: boolean;
    /** Recent throughput samples, oldest first, for the sparkline. */
    samples: number[];
    /**
     * Recent notable moments. Each carries its own id because the list is a
     * sliding window — keying on position would make React reuse a row for a
     * different event as the window moves.
     */
    events: Array<{ id: number; text: string }>;
}

/** Terminal must be at least this big for the layout to make sense. */
const MIN_COLUMNS = 60;
const MIN_ROWS = 15;

export interface PromotionInput {
    stdoutIsTTY: boolean;
    stderrIsTTY: boolean;
    columns: number;
    rows: number;
    json: boolean;
    /** --tui / --no-tui, when the user said. */
    force?: boolean;
    env: Record<string, string | undefined>;
    /** Bytes about to move. */
    totalBytes: number;
    /** The instance's multipart threshold: the point a transfer stops being brief. */
    threshold: number;
}

/**
 * Whether to take over the terminal.
 *
 * `--tui` overrides everything except the things that make it impossible: a
 * pipe has nowhere to draw, and `--json` promises stdout is one object.
 */
export function shouldPromote(input: PromotionInput): boolean {
    if (input.json) {
        return false;
    }
    if (!input.stdoutIsTTY || !input.stderrIsTTY) {
        return false;
    }
    if (input.env.CI || input.env.TERM === 'dumb') {
        return false;
    }
    if (input.columns < MIN_COLUMNS || input.rows < MIN_ROWS) {
        return false;
    }
    if (input.force !== undefined) {
        return input.force;
    }
    // Multipart is exactly the case this exists for: a transfer big enough to
    // have parts is a transfer big enough to watch.
    return input.totalBytes >= input.threshold;
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** A sparkline scaled to its own peak, so a slow link still shows shape. */
export function sparkline(samples: number[], width: number): string {
    if (samples.length === 0) {
        return ' '.repeat(width);
    }
    const recent = samples.slice(-width);
    const peak = Math.max(...recent, 1);
    return recent
        .map((value) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((value / peak) * 8))])
        .join('')
        .padStart(width, ' ');
}

/**
 * A coarse map of the parts: done, in flight, pending.
 *
 * Deliberately not one cell per part — a 1 TB upload has 7,451 of them. The bar
 * is a proportion, which is the only thing a person can read at that scale.
 */
export function partsBar(done: number, inFlight: number, total: number, width: number): string {
    if (total <= 0) {
        return '░'.repeat(width);
    }
    const filled = Math.round((done / total) * width);
    const active = Math.min(
        width - filled,
        Math.round((inFlight / total) * width) || (inFlight ? 1 : 0),
    );
    return ('█'.repeat(filled) + '▒'.repeat(Math.max(0, active)))
        .padEnd(width, '░')
        .slice(0, width);
}

function Dashboard({ model }: { model: DashboardModel }) {
    const width = Math.max(20, Math.min((process.stdout.columns ?? 80) - 20, 44));
    const fraction = model.total ? model.uploaded / model.total : 0;
    const eta = model.eta === null ? '—' : formatDuration(model.eta);

    return (
        <Stack direction="column" gap={0}>
            <Panel title="sendfm">
                <text>
                    {truncateMiddle(model.label, 40)}
                    {'  '}
                    {formatBytes(model.total)}
                    {model.encrypted ? '  encrypted' : ''}
                </text>
            </Panel>

            <Panel>
                <Stack direction="column" gap={0}>
                    <ProgressBar value={Math.round(fraction * 100)} />
                    <text>
                        {formatBytes(model.uploaded)} / {formatBytes(model.total)}
                        {'    '}
                        {formatRate(model.rate)}
                        {'    eta '}
                        {eta}
                    </text>
                    <text>{sparkline(model.samples, width)}</text>
                </Stack>
            </Panel>

            <Panel title="parts">
                <Stack direction="column" gap={0}>
                    <text>
                        {partsBar(model.partsDone, model.inFlight, model.partsTotal, width)}
                    </text>
                    <text>
                        {model.partsDone} done · {model.inFlight} in flight · {model.retries}{' '}
                        retried · concurrency {model.concurrency}
                    </text>
                </Stack>
            </Panel>

            <Panel title="events">
                <Stack direction="column" gap={0}>
                    {model.events.slice(-4).map((event) => (
                        <text key={event.id}>{event.text}</text>
                    ))}
                </Stack>
            </Panel>
        </Stack>
    );
}

export interface DashboardHandle {
    update(model: DashboardModel): void;
    stop(): void;
}

/**
 * Mount the dashboard. The caller owns reprinting the result afterwards,
 * because unmounting an alt-screen app takes its contents with it.
 */
export async function mountDashboard(initial: DashboardModel): Promise<DashboardHandle> {
    const renderer = await createCliRenderer();
    const root = createRoot(renderer);
    let model = initial;
    let live = true;

    const draw = () => {
        if (live) {
            root.render(<Dashboard model={model} />);
        }
    };
    draw();

    return {
        update(next) {
            model = next;
            draw();
        },
        stop() {
            if (!live) {
                return;
            }
            live = false;
            root.unmount();
            // Hand the terminal back before anything is printed to the normal
            // buffer, or the summary lands inside the alt screen and vanishes.
            renderer.destroy?.();
        },
    };
}
