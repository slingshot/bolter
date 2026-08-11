import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    acquireUploadLock,
    resetUploadLifecycleForTests,
    UploadLockBusyError,
    withUploadLifecycle,
} from '../upload-lifecycle';

interface FakeSentinel {
    released: boolean;
    release: ReturnType<typeof vi.fn>;
}

/** A `navigator.wakeLock` stand-in that records every sentinel it hands out. */
function fakeWakeLock() {
    const sentinels: FakeSentinel[] = [];
    const request = vi.fn((_type: string) => {
        const sentinel: FakeSentinel = {
            released: false,
            release: vi.fn(() => {
                sentinel.released = true;
                return Promise.resolve();
            }),
        };
        sentinels.push(sentinel);
        return Promise.resolve(sentinel);
    });
    return { wakeLock: { request }, sentinels, request };
}

/** happy-dom lacks wakeLock/locks/storage — each test stubs what it needs. */
function stubNavigator(overrides: Record<string, unknown>): void {
    vi.stubGlobal('navigator', { onLine: true, ...overrides });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('withUploadLifecycle', () => {
    beforeEach(() => {
        resetUploadLifecycleForTests();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('acquires the wake lock for the run and releases it on success', async () => {
        const { wakeLock, sentinels, request } = fakeWakeLock();
        stubNavigator({ wakeLock });

        const result = await withUploadLifecycle('fi_success', async () => {
            await flush();
            return 'ok';
        });

        expect(result).toBe('ok');
        expect(request).toHaveBeenCalledWith('screen');
        expect(sentinels).toHaveLength(1);
        expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    });

    it('releases the wake lock when the run throws', async () => {
        const { wakeLock, sentinels } = fakeWakeLock();
        stubNavigator({ wakeLock });

        await expect(
            withUploadLifecycle('fi_throw', async () => {
                await flush();
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(sentinels).toHaveLength(1);
        expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    });

    it('re-acquires the wake lock on visibilitychange while running, but not after settle', async () => {
        const { wakeLock, sentinels, request } = fakeWakeLock();
        stubNavigator({ wakeLock });

        let finishRun!: () => void;
        const gate = new Promise<void>((resolve) => {
            finishRun = resolve;
        });
        const running = withUploadLifecycle('fi_visibility', () => gate);
        await flush(); // initial acquisition settles
        expect(request).toHaveBeenCalledTimes(1);

        document.dispatchEvent(new Event('visibilitychange'));
        await flush();
        expect(request).toHaveBeenCalledTimes(2);

        finishRun();
        await running;
        // Every sentinel handed out ends up released.
        expect(sentinels).toHaveLength(2);
        for (const sentinel of sentinels) {
            expect(sentinel.release).toHaveBeenCalled();
        }

        // Settled lifecycles stop listening.
        document.dispatchEvent(new Event('visibilitychange'));
        await flush();
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('treats a rejected wake lock request as best-effort', async () => {
        const request = vi.fn(() => Promise.reject(new Error('denied')));
        stubNavigator({ wakeLock: { request } });

        await expect(withUploadLifecycle('fi_denied', async () => 'ok')).resolves.toBe('ok');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('requests storage.persist() at most once across two runs', async () => {
        const persist = vi.fn(async () => true);
        stubNavigator({ storage: { persist } });

        await withUploadLifecycle('fi_first', async () => 1);
        await withUploadLifecycle('fi_second', async () => 2);

        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('still runs when wake lock, locks, and storage APIs are all missing', async () => {
        stubNavigator({}); // bare navigator — nothing to feature-detect
        await expect(withUploadLifecycle('fi_bare', async () => 'ran')).resolves.toBe('ran');
    });
});

describe('acquireUploadLock', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('throws UploadLockBusyError without invoking run when the lock is held elsewhere', async () => {
        const request = vi.fn(
            async (
                _name: string,
                _opts: { ifAvailable: boolean },
                callback: (lock: unknown) => unknown,
            ) => await callback(null), // ifAvailable grant refused → null lock
        );
        stubNavigator({ locks: { request } });

        const run = vi.fn(async () => 'never');
        await expect(acquireUploadLock('fi_busy', run)).rejects.toBeInstanceOf(UploadLockBusyError);
        expect(run).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledWith(
            'upload:fi_busy',
            { ifAvailable: true },
            expect.any(Function),
        );
    });

    it('holds the lock for the full duration of run and resolves with its value', async () => {
        const events: string[] = [];
        const request = vi.fn(
            async (
                name: string,
                _opts: { ifAvailable: boolean },
                callback: (lock: unknown) => unknown,
            ) => {
                events.push('granted');
                const result = await callback({ name });
                events.push('released');
                return result;
            },
        );
        stubNavigator({ locks: { request } });

        const result = await acquireUploadLock('fi_hold', async () => {
            events.push('run-start');
            await flush();
            events.push('run-end');
            return 42;
        });

        expect(result).toBe(42);
        expect(events).toEqual(['granted', 'run-start', 'run-end', 'released']);
    });

    it('runs without a lock when the Web Locks API is missing', async () => {
        stubNavigator({});
        await expect(acquireUploadLock('fi_nolocks', async () => 'ran')).resolves.toBe('ran');
    });
});
