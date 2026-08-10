/**
 * Main-thread facade for the worker upload engine: eligibility probe, worker
 * spawn, typed message relay, connectivity relay, and cancel escalation.
 *
 * This is the one engine module that intentionally runs on the main thread —
 * it owns the `window` online/offline relay and the `localStorage` kill
 * switch, and must never be imported from the worker.
 *
 * Cancel is an acknowledged protocol [R6]: the client posts `cancel` and the
 * worker aborts its XHRs, performs the authenticated server-side abort, and
 * acks with `cancelled` before running its local cleanup. If no ack arrives
 * within 10s wall-clock (worker crashed or suspended), the client terminates
 * the worker and performs the authenticated abort itself — preserving the
 * guarantees of the legacy synchronous `Canceller.cancel()`.
 */

import type { EngineResult } from './engine';
import type {
    ClientToWorker,
    EngineJob,
    EngineProbeRequest,
    EngineProbeResult,
    WorkerToClient,
} from './protocol';
import type { CompletionEnvelope } from './state';

/** `localStorage[ENGINE_KILL_SWITCH_KEY] === 'off'` disables the engine. */
export const ENGINE_KILL_SWITCH_KEY = 'bolter:upload-engine';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const CANCEL_ACK_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

// Worker creation is injectable for tests, but the `new Worker(new URL(...))`
// literal must stay in this module for Vite's static analysis [R17].
let workerFactory: () => Worker = () =>
    new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });

export function setWorkerFactory(f: () => Worker): void {
    workerFactory = f;
}

export interface EngineEligibility {
    eligible: boolean;
    reason?: string;
}

export interface EngineClientHooks {
    onProgress(sent: number, total: number): void;
    onRetry(): void;
}

/** Terminal engine failure relayed from the worker; `retryable` mirrors the
 * engine's classification so callers can offer resume vs start-fresh. */
export class EngineWorkerError extends Error {
    readonly retryable: boolean;

    constructor(message: string, retryable: boolean) {
        super(message);
        this.name = 'EngineWorkerError';
        this.retryable = retryable;
    }
}

function killSwitchOn(): boolean {
    try {
        return (
            typeof localStorage !== 'undefined' &&
            localStorage.getItem(ENGINE_KILL_SWITCH_KEY) === 'off'
        );
    } catch {
        // Storage access can throw in privacy modes — that alone is not a veto
        // (the OPFS round trip below is the real capability check).
        return false;
    }
}

/**
 * Per-upload eligibility probe: kill switch → worker spawn → OPFS
 * `getDirectory` → 1-byte sync-access-handle write/read round trip →
 * `storage.estimate()` (advisory). Any failure means the caller falls through
 * to the legacy pipeline silently.
 */
export async function probeEligibility(): Promise<EngineEligibility> {
    if (killSwitchOn()) {
        return { eligible: false, reason: 'kill-switch' };
    }
    if (typeof Worker === 'undefined') {
        return { eligible: false, reason: 'no-worker' };
    }
    let worker: Worker;
    try {
        worker = workerFactory();
    } catch {
        return { eligible: false, reason: 'worker-spawn-failed' };
    }
    try {
        const result = await new Promise<EngineProbeResult>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
            worker.onmessage = (event: MessageEvent) => {
                const message = event.data as EngineProbeResult | undefined;
                if (message?.type === 'probe-result') {
                    clearTimeout(timer);
                    resolve(message);
                }
            };
            worker.onerror = (event) => {
                clearTimeout(timer);
                reject(new Error(event.message || 'engine worker failed to start'));
            };
            worker.postMessage({ type: 'probe' } satisfies EngineProbeRequest);
        });
        return result.ok
            ? { eligible: true }
            : { eligible: false, reason: result.reason ?? 'probe-failed' };
    } catch (err) {
        return {
            eligible: false,
            reason: err instanceof Error ? err.message : String(err),
        };
    } finally {
        worker.terminate();
    }
}

/**
 * Run one engine job in a fresh worker. Resolves on `done`, rejects with
 * `EngineWorkerError` on `error` and with a plain cancellation error once a
 * cancel completes (acked or escalated). Relays `online`/`offline` window
 * events to the worker as `connectivity` messages for the whole run.
 */
export function runEngineInWorker(
    job: EngineJob,
    envelope: CompletionEnvelope,
    hooks: EngineClientHooks,
    canceller: { onCancel(cb: () => void): void },
): Promise<EngineResult> {
    const worker = workerFactory();
    return new Promise<EngineResult>((resolve, reject) => {
        let settled = false;
        let cancelRequested = false;
        let escalationTimer: ReturnType<typeof setTimeout> | undefined;

        const post = (message: ClientToWorker) => worker.postMessage(message);
        const onOnline = () => post({ type: 'connectivity', online: true });
        const onOffline = () => post({ type: 'connectivity', online: false });
        if (typeof window !== 'undefined') {
            window.addEventListener('online', onOnline);
            window.addEventListener('offline', onOffline);
        }

        const settle = (finish: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            if (escalationTimer !== undefined) {
                clearTimeout(escalationTimer);
            }
            if (typeof window !== 'undefined') {
                window.removeEventListener('online', onOnline);
                window.removeEventListener('offline', onOffline);
            }
            finish();
        };

        worker.onmessage = (event: MessageEvent) => {
            const message = event.data as WorkerToClient;
            switch (message.type) {
                case 'progress':
                    hooks.onProgress(message.bytesSent, message.totalBytes);
                    break;
                case 'retry':
                    hooks.onRetry();
                    break;
                case 'done':
                    settle(() => resolve({ actualSize: message.actualSize }));
                    break;
                case 'error':
                    settle(() => {
                        worker.terminate();
                        reject(new EngineWorkerError(message.message, message.retryable));
                    });
                    break;
                case 'cancelled':
                    // Ack received: the worker still has local cleanup to run
                    // (part-store destroy, state clear) and closes itself when
                    // finished — terminating here would kill that cleanup
                    // mid-flight [R6].
                    settle(() => reject(new Error('Upload cancelled')));
                    break;
            }
        };
        worker.onerror = (event) => {
            settle(() => {
                worker.terminate();
                reject(new EngineWorkerError(event.message || 'engine worker crashed', true));
            });
        };

        canceller.onCancel(() => {
            if (settled || cancelRequested) {
                return;
            }
            cancelRequested = true;
            post({ type: 'cancel' });
            // Escalation [R6]: no ack within the window means the worker is
            // crashed or suspended — kill it and run the authenticated abort
            // from the main thread instead.
            escalationTimer = setTimeout(() => {
                settle(() => {
                    worker.terminate();
                    void abortEngineUpload(job.fileId, job.uploadId, job.uploadToken).catch(
                        () => undefined, // best-effort — the bucket lifecycle rule reaps leftovers
                    );
                    reject(new Error('Upload cancelled'));
                });
            }, CANCEL_ACK_TIMEOUT_MS);
        });

        post({ type: 'start', job, envelope });
    });
}

/**
 * Main-thread authenticated multipart abort — the same `/upload/abort/:id`
 * contract the worker uses, for the cancel-escalation path where the worker
 * can no longer be trusted to make the call itself.
 */
export async function abortEngineUpload(
    fileId: string,
    uploadId: string,
    uploadToken?: string,
): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/upload/abort/${fileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, ...(uploadToken !== undefined && { uploadToken }) }),
    });
    if (!response.ok) {
        throw new Error(`failed to abort upload: HTTP ${response.status}`);
    }
}
