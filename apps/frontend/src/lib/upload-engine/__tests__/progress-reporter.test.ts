import { describe, expect, it } from 'vitest';
import type { UploadProgress } from '@/lib/api';
import { createEngineProgressReporter } from '../progress-reporter';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Reporter under a deterministic wall clock. `advance` moves the clock and
 * fires the 1s emit poll as it comes due, so every assertion sees the same
 * sample stream the UI would.
 */
function harness(totalSize = 0, opts: { online?: boolean } = {}) {
    let t = 0;
    let online = opts.online ?? true;
    let nextId = 1;
    const timers: { id: number; fn: () => void; ms: number; next: number }[] = [];
    const samples: UploadProgress[] = [];

    const reporter = createEngineProgressReporter(totalSize, (p) => samples.push(p), {
        now: () => t,
        isOnline: () => online,
        setIntervalFn: (fn, ms) => {
            const id = nextId++;
            timers.push({ id, fn, ms, next: t + ms });
            return id;
        },
        clearIntervalFn: (handle) => {
            const idx = timers.findIndex((timer) => timer.id === handle);
            if (idx >= 0) {
                timers.splice(idx, 1);
            }
        },
    });

    return {
        reporter,
        samples,
        now: () => t,
        setOnline(value: boolean) {
            online = value;
        },
        advance(ms: number) {
            const target = t + ms;
            while (true) {
                const due = timers
                    .filter((timer) => timer.next <= target)
                    .sort((a, b) => a.next - b.next)[0];
                if (!due) {
                    break;
                }
                t = due.next;
                due.next += due.ms;
                due.fn();
            }
            t = target;
        },
        last(): UploadProgress {
            const sample = samples[samples.length - 1];
            if (!sample) {
                throw new Error('no progress reported yet');
            }
            return sample;
        },
        timerCount: () => timers.length,
    };
}

describe('createEngineProgressReporter', () => {
    it('reports the true rate when main-thread jank drains a window of messages in a burst', () => {
        const total = 600 * MB;
        const rate = 10 * MB; // bytes/s actually moving over the link
        const h = harness(total);
        let sent = 0;

        // Each second's worth of worker messages is queued behind a busy main
        // thread and drained 1ms apart at the top of the next second — the
        // exact shape that made per-message folding invent 100+ MB/s.
        for (let second = 0; second < 60; second++) {
            h.advance(980);
            for (let k = 0; k < 20; k++) {
                sent += rate / 20;
                h.reporter.onProgress(sent, total);
                h.advance(1);
            }
        }

        expect(h.last().speed).toBeGreaterThan(rate * 0.95);
        expect(h.last().speed).toBeLessThan(rate * 1.05);
        // No sample may fabricate throughput, not even transiently: the ETA is
        // computed from whatever the latest one says.
        for (const sample of h.samples) {
            expect(sample.speed).toBeLessThanOrEqual(rate * 1.25);
        }
    });

    it('never seeds the EMA from a resume baseline', () => {
        const total = 6 * GB;
        const baseline = 5 * GB; // bytes a previous session already uploaded
        const h = harness(total);

        h.advance(200);
        h.reporter.onProgress(baseline, total);

        // The baseline is real progress for the bar...
        expect(h.last().loaded).toBe(baseline);
        expect(h.last().percentage).toBeCloseTo((baseline / total) * 100, 6);
        // ...but it was never transferred in this session, so it is not a rate.
        expect(h.last().speed).toBe(0);
        expect(h.last().remainingTime).toBe(0);

        let sent = baseline;
        for (let i = 0; i < 5; i++) {
            h.advance(1000);
            sent += 10 * MB;
            h.reporter.onProgress(sent, total);
        }

        expect(h.last().speed).toBe(10 * MB);
        expect(h.last().remainingTime).toBeCloseTo((total - sent) / (10 * MB), 6);
    });

    it('keeps the display monotonic and re-baselines the rate when a retry drops in-flight bytes', () => {
        const total = 100 * MB;
        const h = harness(total);
        let sent = 0;
        h.reporter.onProgress(sent, total);

        // 15MB at a steady 10MB/s.
        for (let i = 0; i < 15; i++) {
            h.advance(100);
            sent += MB;
            h.reporter.onProgress(sent, total);
        }
        expect(h.last().speed).toBe(10 * MB);
        expect(h.last().loaded).toBe(15 * MB);

        // A part retry drops every in-flight byte, below the open window's
        // origin: the delta now measures the drop, not the link.
        h.advance(100);
        h.reporter.onProgress(8 * MB, total);
        expect(h.last().loaded).toBe(15 * MB);
        expect(h.last().speed).toBe(10 * MB); // no garbage fold on the drop

        // The window restarted at the regressed count, so the next honest
        // second reports the link's real rate.
        h.advance(1000);
        h.reporter.onProgress(18 * MB, total);
        expect(h.last().speed).toBe(10 * MB);

        let high = 0;
        for (const sample of h.samples) {
            expect(sample.loaded).toBeGreaterThanOrEqual(high);
            high = sample.loaded;
            expect(sample.speed).toBeGreaterThanOrEqual(0);
        }
    });

    it('folds bytes delivered with an identical timestamp instead of discarding them', () => {
        const total = 50 * MB;
        const h = harness(total);
        h.reporter.onProgress(0, total);

        // Five messages, one clock tick: the old reporter skipped the fold on
        // zero elapsed but still advanced its baseline, erasing 10MB from the
        // rate entirely.
        h.advance(500);
        for (let i = 1; i <= 5; i++) {
            h.reporter.onProgress(i * 2 * MB, total);
        }

        h.advance(500);
        h.reporter.onProgress(10 * MB, total);
        expect(h.last().speed).toBe(10 * MB);
    });

    it('prefers the producer timestamp over delivery time', () => {
        const total = 100 * MB;
        const h = harness(total);

        h.reporter.onProgress(0, total, 0);
        // The main thread was blocked for 5s; the worker stamped both messages
        // 1s apart while the bytes were actually moving.
        h.advance(5000);
        h.reporter.onProgress(10 * MB, total, 1000);

        expect(h.last().speed).toBe(10 * MB);
    });

    it('maps smoothed speed onto the unchanged connection-quality bands', () => {
        const total = 100 * MB;
        const h = harness(total);
        h.reporter.onProgress(0, total);
        expect(h.last().connectionQuality).toBe('stalled'); // no sample yet

        h.advance(1000);
        h.reporter.onProgress(512 * 1024, total);
        expect(h.last().connectionQuality).toBe('slow');

        h.advance(1000);
        h.reporter.onProgress(512 * 1024 + 20 * MB, total);
        expect(h.last().connectionQuality).toBe('fair');

        for (let i = 0; i < 6; i++) {
            h.advance(1000);
            h.reporter.onProgress(512 * 1024 + (i + 2) * 20 * MB, total);
        }
        expect(h.last().connectionQuality).toBe('good');

        h.setOnline(false);
        h.advance(1000);
        expect(h.last().connectionQuality).toBe('offline');
        expect(h.last().isOffline).toBe(true);

        // Bytes stopped moving for longer than the stall threshold.
        h.setOnline(true);
        h.advance(11_000);
        expect(h.last().connectionQuality).toBe('stalled');
    });

    it('counts retries and stops the emit poll on stop()', () => {
        const h = harness(10 * MB);
        h.reporter.onRetry();
        h.reporter.onRetry();
        expect(h.last().retryCount).toBe(2);

        h.advance(1000);
        const emitted = h.samples.length;
        h.reporter.stop();
        expect(h.timerCount()).toBe(0);
        h.advance(10_000);
        expect(h.samples).toHaveLength(emitted);
    });
});
