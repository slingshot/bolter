/**
 * The full-screen transfer dashboard.
 *
 * "Full-screen" is a historical name: it renders *inline*, into the normal
 * buffer, the way Claude Code and every other Ink app does. It used to take
 * the alternate screen, which cost more than it bought — an alt-screen app
 * discards everything it drew on exit, so the share link it had just produced
 * had to be reprinted afterwards, and the transfer left no trace in scrollback
 * at all. Rendering inline means the last frame simply stays where it is.
 *
 * Promoted only for a transfer long enough to be worth watching, and only into
 * a terminal that can seat the whole frame — see `shouldPromote`.
 */

import { Box, render, Text, useWindowSize } from 'ink';
import { useEffect, useState } from 'react';
import type { UploadProgress } from '../transfer/upload';
import { formatBytes, formatDuration, formatRate, progressBar, truncateMiddle } from './format';

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

/**
 * Rows the frame occupies: two borders and six lines of content.
 *
 * This is not decoration. The previous layout stacked four separately
 * bordered panels, each with padding and a gap, and spent about 28 rows
 * showing eight lines — while promotion admitted terminals of 15. The excess
 * did not scroll or clip; it painted over the borders and over the other
 * panels, which is what "the TUI goes weird when you resize" was. Resizing
 * was never required to trigger it, only a short enough terminal.
 */
export const DASHBOARD_ROWS = 8;

/**
 * Rows a terminal must have before the dashboard is allowed to draw.
 *
 * Deliberately larger than the frame: an inline renderer needs a line for the
 * cursor and the caller prints a result underneath, and a frame that exactly
 * fills the terminal scrolls its own top edge away on every redraw.
 */
export const MIN_ROWS = DASHBOARD_ROWS + 2;

/** Narrower than this and the bars have no room to say anything. */
export const MIN_COLUMNS = 60;

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
 * Whether to draw the dashboard.
 *
 * `--tui` overrides the size heuristic but not the things that make drawing
 * impossible: a pipe has nowhere to draw, `--json` promises stdout is one
 * object, and forcing cannot conjure rows that do not exist.
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

/**
 * How wide the drawn content may be.
 *
 * Everything inside the frame is a pre-sized string rather than a flex child,
 * because a bar is only meaningful at a known cell count. That makes the width
 * a render-time input, and the whole point of taking it from `useWindowSize`
 * rather than reading `stderr.columns` inline is that the hook re-renders on
 * resize — the old code sampled the width during render and then only redrew
 * on a progress tick, so a resized terminal kept the old geometry until the
 * next byte arrived, and forever if the transfer had finished.
 */
function contentWidth(columns: number): number {
    // Two border cells and two padding cells.
    return Math.max(MIN_COLUMNS - 4, columns - 4);
}

function Dashboard({ model }: { model: DashboardModel }) {
    const { columns } = useWindowSize();
    const inner = contentWidth(columns);

    const fraction = model.total ? model.uploaded / model.total : 0;
    const percent = `${Math.floor(fraction * 100)}%`;
    const eta = model.eta === null ? '—' : formatDuration(model.eta);

    // The bars share the row with their trailing label, so they get whatever
    // the label does not use rather than a constant.
    const barWidth = Math.max(10, Math.min(inner - percent.length - 2, 48));
    const partsLabel =
        `${model.partsDone}/${model.partsTotal} parts` +
        `${model.inFlight ? ` · ${model.inFlight} in flight` : ''}` +
        `${model.retries ? ` · ${model.retries} retried` : ''}`;
    const partsWidth = Math.max(8, Math.min(inner - partsLabel.length - 2, 32));

    const size = formatBytes(model.total);
    const suffix = model.encrypted ? `${size} · encrypted` : size;
    const name = truncateMiddle(model.label, Math.max(8, inner - suffix.length - 2));

    const latest = model.events.at(-1);

    return (
        <Box borderStyle="round" borderDimColor flexDirection="column" paddingX={1}>
            <Box>
                <Box flexGrow={1}>
                    <Text bold wrap="truncate">
                        {name}
                    </Text>
                </Box>
                <Text dimColor>{suffix}</Text>
            </Box>

            <Text>
                {progressBar(fraction, barWidth)} <Text dimColor>{percent}</Text>
            </Text>

            <Text dimColor>
                {formatBytes(model.uploaded)} / {size} {'  '} {formatRate(model.rate)} {'  '} eta{' '}
                {eta}
            </Text>

            <Text dimColor>{sparkline(model.samples, barWidth)}</Text>

            <Text>
                <Text dimColor>
                    {partsBar(model.partsDone, model.inFlight, model.partsTotal, partsWidth)}
                </Text>
                {'  '}
                <Text dimColor>{partsLabel}</Text>
            </Text>

            {/* Always drawn, blank when there is nothing to say: a row that
                appears and disappears changes the frame height mid-transfer,
                and an inline renderer redraws by counting lines. */}
            <Text dimColor>{latest ? `· ${truncateMiddle(latest.text, inner - 2)}` : ' '}</Text>
        </Box>
    );
}

export interface DashboardHandle {
    update(model: DashboardModel): void;
    stop(): void;
}

/**
 * A store rather than `rerender()` on every tick.
 *
 * Resize and progress are two independent sources of change, and only a
 * component that owns its state can respond to both. Driving updates from
 * outside via `rerender` would re-introduce exactly the staleness this
 * rewrite removes: `useWindowSize` would fire, but the frame would still be
 * built from whatever the last progress tick passed in.
 */
function createStore(initial: DashboardModel) {
    let current = initial;
    const listeners = new Set<(model: DashboardModel) => void>();
    const notify = () => {
        for (const listener of listeners) {
            listener(current);
        }
    };
    return {
        get: () => current,
        set(next: DashboardModel) {
            current = next;
            notify();
        },
        subscribe(listener: (model: DashboardModel) => void) {
            listeners.add(listener);
            // Returns void, not Set.delete's boolean: React treats any
            // non-function return from an effect as a mistake, and a
            // boolean-returning cleanup does not typecheck as a Destructor.
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

type Store = ReturnType<typeof createStore>;

function Live({ store }: { store: Store }) {
    const [model, setModel] = useState(store.get);
    useEffect(() => store.subscribe(setModel), [store]);
    return <Dashboard model={model} />;
}

/**
 * Mount the dashboard onto stderr.
 *
 * stderr, not stdout, because stdout is the result: `sendfm up notes.pdf |
 * pbcopy` must copy a share link and nothing else. The old renderer defaulted
 * to `process.stdout` and was saved only by refusing to promote unless stdout
 * was a TTY — a guard rather than a design.
 */
export function mountDashboard(initial: DashboardModel): DashboardHandle {
    const store = createStore(initial);
    const instance = render(<Live store={store} />, {
        stdout: process.stderr,
        // Ink's Ctrl+C handling would exit the process directly, skipping the
        // cancel path that aborts the multipart server-side. Interrupted
        // uploads leave LIST-invisible billable parts, so the signal has to
        // reach the CLI's own handler.
        exitOnCtrlC: false,
        patchConsole: false,
        // Only the lines that changed are rewritten, which is most of the
        // point at a 10 Hz progress cadence.
        incrementalRendering: true,
        alternateScreen: false,
    });

    let live = true;
    return {
        update(next) {
            if (live) {
                store.set(next);
            }
        },
        stop() {
            if (!live) {
                return;
            }
            live = false;
            // The final frame stays in scrollback; nothing needs reprinting.
            instance.unmount();
        },
    };
}
