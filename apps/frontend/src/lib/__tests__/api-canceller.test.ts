import { describe, expect, it } from 'vitest';
import { Canceller } from '@/lib/api';

/**
 * Real XHRs dispatch loadend SYNCHRONOUSLY from abort(). The upload code's
 * loadend handlers call canceller.removeXhr(), so cancelling must tolerate
 * the tracked-XHR list mutating mid-iteration. This fake reproduces that
 * reentrancy: abort() immediately invokes the registered cleanup callback.
 */
class ReentrantFakeXhr {
    readyState = 1; // OPENED — in flight
    aborted = false;
    onLoadend: (() => void) | null = null;

    abort() {
        this.aborted = true;
        this.readyState = 4; // DONE
        this.onLoadend?.(); // synchronous, like the real XHR spec
    }
}

describe('Canceller', () => {
    it('aborts every in-flight XHR even when handlers remove themselves synchronously', () => {
        const canceller = new Canceller();
        const xhrs = [new ReentrantFakeXhr(), new ReentrantFakeXhr(), new ReentrantFakeXhr()];

        for (const xhr of xhrs) {
            // Mirror uploadPart's loadend handler, which unregisters the XHR
            xhr.onLoadend = () => canceller.removeXhr(xhr as unknown as XMLHttpRequest);
            canceller.addXhr(xhr as unknown as XMLHttpRequest);
        }

        canceller.cancel();

        expect(canceller.cancelled).toBe(true);
        // Before the snapshot fix, removeXhr() during iteration shifted the
        // array and every other XHR escaped abortion
        expect(xhrs.map((x) => x.aborted)).toEqual([true, true, true]);
    });

    it('skips XHRs that already finished', () => {
        const canceller = new Canceller();
        const done = new ReentrantFakeXhr();
        done.readyState = 4; // DONE
        canceller.addXhr(done as unknown as XMLHttpRequest);

        canceller.cancel();

        expect(done.aborted).toBe(false);
    });
});
