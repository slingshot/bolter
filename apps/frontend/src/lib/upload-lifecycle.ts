/**
 * Upload lifecycle extras: Screen Wake Lock, Web Locks, `storage.persist()`.
 *
 * - `withUploadLifecycle` wraps an upload attempt (engine or legacy alike) in
 *   a best-effort screen wake lock — re-acquired on `visibilitychange`, since
 *   the UA auto-releases the sentinel when the page hides — and requests
 *   `navigator.storage.persist()` once per session. Nothing depends on either:
 *   every API is feature-detected and absence is a no-op [R14].
 * - `acquireUploadLock` holds the `upload:<fileId>` Web Lock for the FULL
 *   duration of `run` [R12] — no probe-then-release TOCTOU. The lock is
 *   coordination only (it auto-releases when its agent dies); the durable
 *   engine lease stays the source of truth.
 *
 * Worker-importable: the engine worker uses `acquireUploadLock` (the Web Locks
 * API exists in workers), so nothing here touches `window` or reads DOM
 * globals without a `typeof` guard — `document` is only used when present.
 */

/** Thrown by `acquireUploadLock` when another tab/worker holds the lock. */
export class UploadLockBusyError extends Error {
    constructor(fileId: string) {
        super(`upload ${fileId} is already running in another tab or worker`);
        this.name = 'UploadLockBusyError';
    }
}

// Structural views of the browser APIs (house pattern: cast at the boundary),
// so the module never depends on which DOM lib surface this app compiles
// against and stays importable from the worker.
interface WakeLockSentinelLike {
    release(): Promise<void>;
}
interface WakeLockLike {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
}
interface LockManagerLike {
    request<T>(
        name: string,
        options: { ifAvailable: boolean },
        callback: (lock: unknown) => Promise<T> | T,
    ): Promise<T>;
}
interface StorageManagerLike {
    persist?(): Promise<boolean>;
}
interface LifecycleNavigator {
    wakeLock?: WakeLockLike;
    locks?: LockManagerLike;
    storage?: StorageManagerLike;
}
interface LifecycleDocument {
    visibilityState?: string;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
}

function lifecycleNavigator(): LifecycleNavigator | undefined {
    return (globalThis as { navigator?: unknown }).navigator as LifecycleNavigator | undefined;
}

function lifecycleDocument(): LifecycleDocument | undefined {
    return (globalThis as { document?: unknown }).document as LifecycleDocument | undefined;
}

/** `storage.persist()` is a once-per-session request — it changes eviction
 * policy, not capacity, and repeating it is pointless noise. */
let persistRequested = false;

/** Test seam: clears the once-per-session `storage.persist()` latch. */
export function resetUploadLifecycleForTests(): void {
    persistRequested = false;
}

/** Outcome of the once-per-session `storage.persist()` request. */
export type StoragePersistResult = 'granted' | 'denied' | 'error';

let persistResultListener: ((result: StoragePersistResult) => void) | undefined;

/**
 * Telemetry seam [R16]: observe the once-per-session `storage.persist()`
 * outcome. Single listener — registering replaces any previous one. The
 * result stays advisory; nothing in the upload depends on it.
 */
export function onStoragePersistResult(listener: (result: StoragePersistResult) => void): void {
    persistResultListener = listener;
}

function notifyPersistResult(result: StoragePersistResult): void {
    try {
        persistResultListener?.(result);
    } catch {
        // telemetry only — never disturb the upload
    }
}

function requestStoragePersistOnce(): void {
    if (persistRequested) {
        return;
    }
    const storage = lifecycleNavigator()?.storage;
    if (!storage || typeof storage.persist !== 'function') {
        return;
    }
    persistRequested = true;
    // Advisory — the result is not load-bearing, but it is telemetry [R16].
    void storage.persist().then(
        (granted) => notifyPersistResult(granted ? 'granted' : 'denied'),
        () => notifyPersistResult('error'),
    );
}

/**
 * Wrap one upload attempt in the lifecycle extras. `fileId` is a correlation
 * label only (the server fileId may not exist yet when the wrap begins —
 * callers pass a per-attempt id in that case); no behavior keys off it.
 */
export async function withUploadLifecycle<T>(fileId: string, run: () => Promise<T>): Promise<T> {
    void fileId;
    requestStoragePersistOnce();
    const wakeLock = startWakeLockHold();
    try {
        return await run();
    } finally {
        await wakeLock.release();
    }
}

/**
 * Best-effort screen wake lock held until `release()`. The UA auto-releases
 * the sentinel whenever the page hides, so a `visibilitychange` back to
 * visible drops the stale sentinel and takes a fresh one. Request rejections
 * (battery saver, hidden document, permission policy) are swallowed — the
 * upload never depends on the lock.
 */
function startWakeLockHold(): { release(): Promise<void> } {
    let released = false;
    let sentinel: WakeLockSentinelLike | undefined;
    let pending: Promise<void> = Promise.resolve();

    const acquire = (): void => {
        const wakeLock = lifecycleNavigator()?.wakeLock;
        if (released || !wakeLock || typeof wakeLock.request !== 'function') {
            return;
        }
        pending = Promise.resolve()
            .then(() => wakeLock.request('screen'))
            .then((granted) => {
                if (released) {
                    // The run settled while the request was in flight.
                    void granted.release().catch(() => undefined);
                    return;
                }
                sentinel = granted;
            })
            .catch(() => undefined);
    };

    const doc = lifecycleDocument();
    const onVisibilityChange = (): void => {
        if (released || doc?.visibilityState !== 'visible') {
            return;
        }
        const stale = sentinel;
        sentinel = undefined;
        if (stale) {
            void stale.release().catch(() => undefined);
        }
        acquire();
    };
    if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibilityChange);
    }
    acquire();

    return {
        async release(): Promise<void> {
            released = true;
            if (doc && typeof doc.removeEventListener === 'function') {
                doc.removeEventListener('visibilitychange', onVisibilityChange);
            }
            await pending;
            if (sentinel) {
                const held = sentinel;
                sentinel = undefined;
                await held.release().catch(() => undefined);
            }
        },
    };
}

/**
 * Run `run` while holding the `upload:<fileId>` Web Lock — for the full
 * duration, never probe-then-release [R12]. Throws `UploadLockBusyError`
 * without invoking `run` when another context holds the lock. Environments
 * without the Web Locks API (older Safari) just run: the durable engine lease
 * is the actual source of truth, the lock is coordination.
 */
export function acquireUploadLock<T>(fileId: string, run: () => Promise<T>): Promise<T> {
    const locks = lifecycleNavigator()?.locks;
    if (!locks || typeof locks.request !== 'function') {
        return run();
    }
    return locks.request(`upload:${fileId}`, { ifAvailable: true }, (lock) => {
        if (lock === null) {
            throw new UploadLockBusyError(fileId);
        }
        return run();
    });
}
