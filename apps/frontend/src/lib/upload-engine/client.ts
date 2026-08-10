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
import { OpfsPartStore, UPLOADS_DIR } from './part-store';
import type {
    ClientToWorker,
    EngineJob,
    EngineProbeRequest,
    EngineProbeResult,
    WorkerToClient,
} from './protocol';
import { planResume } from './resume';
import {
    type CompletionEnvelope,
    type EngineLease,
    type EngineStateStore,
    type HandleSourceFacts,
    openEngineState,
} from './state';

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
    return runWorkerJob(
        { type: 'start', job, envelope },
        { fileId: job.fileId, uploadId: job.uploadId, uploadToken: job.uploadToken },
        hooks,
        canceller,
    );
}

/**
 * Resume a persisted engine upload in a fresh worker (`executeResume` runs
 * in-worker: completion replay or finish-staged). The lease supplies the
 * uploadId/uploadToken the cancel-escalation abort needs.
 */
export async function resumeEngineUploadInWorker(
    fileId: string,
    hooks: EngineClientHooks,
    canceller: { onCancel(cb: () => void): void },
): Promise<EngineResult> {
    const lease = await getEngineLease(fileId);
    if (!lease) {
        throw new Error(`no engine lease for upload ${fileId} — nothing to resume`);
    }
    return runWorkerJob(
        { type: 'resume', fileId },
        { fileId, uploadId: lease.uploadId, uploadToken: lease.uploadToken },
        hooks,
        canceller,
    );
}

/** Credentials the cancel-escalation path needs for the main-thread abort. */
interface WorkerAbortIdentity {
    fileId: string;
    uploadId: string;
    uploadToken?: string;
}

function runWorkerJob(
    initial: ClientToWorker,
    identity: WorkerAbortIdentity,
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
                    void abortEngineUpload(
                        identity.fileId,
                        identity.uploadId,
                        identity.uploadToken,
                    ).catch(
                        () => undefined, // best-effort — the bucket lifecycle rule reaps leftovers
                    );
                    reject(new Error('Upload cancelled'));
                });
            }, CANCEL_ACK_TIMEOUT_MS);
        });

        post(initial);
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

// ---------------------------------------------------------------------------
// Engine persistence access + startup maintenance (resume offers, OPFS GC)
// ---------------------------------------------------------------------------

/** The engine lease for `fileId`, or undefined when none (or no IndexedDB). */
export async function getEngineLease(fileId: string): Promise<EngineLease | undefined> {
    try {
        const state = await openEngineState();
        return await state.getLease(fileId);
    } catch {
        return undefined; // no engine DB → nothing the engine could resume
    }
}

/** True when `fileId` belongs to the worker engine (routing for resumes). */
export async function hasEngineLease(fileId: string): Promise<boolean> {
    return (await getEngineLease(fileId)) !== undefined;
}

/**
 * A persisted engine upload the resume UI can offer. `action: 'finish'`
 * covers both `replay-complete` and `finish-staged` plans — neither needs the
 * source re-picked ("Finish upload — no file selection needed"). The
 * `need-source-*` actions are surfaced for later tasks (persisted-handle
 * one-click resume; multi-file start-fresh).
 */
export interface EngineResumeCandidate {
    fileId: string;
    fileName: string;
    size: number; // original input bytes (manifest sum)
    encrypted: boolean;
    secretKeyB64?: string;
    timeLimit: number;
    downloadLimit: number;
    createdAt: number;
    action: 'finish' | 'need-source-single' | 'need-source-multi';
    /**
     * Persisted File System Access handle for a `need-source-single` resume
     * (Chromium [R13]) — present only when its verification facts survived
     * too, i.e. only when one-click resume is actually possible.
     */
    handle?: FileSystemFileHandle;
    /** Verification facts for `handle`'s file (see `verifyHandleFile`). */
    handleFacts?: HandleSourceFacts;
}

/**
 * Startup maintenance: plan a resume offer for each engine lease, then
 * garbage-collect OPFS staging directories with no lease — skipping any
 * directory whose `upload:<fileId>` Web Lock is held by a live holder [R12].
 * Never throws; an environment without OPFS/IndexedDB simply yields no
 * candidates.
 */
export async function engineStartupMaintenance(): Promise<EngineResumeCandidate[]> {
    let state: EngineStateStore;
    try {
        state = await openEngineState();
    } catch {
        return [];
    }
    const leases = await state.listLeases().catch(() => [] as EngineLease[]);
    const live = new Set<string>();
    const candidates: EngineResumeCandidate[] = [];
    for (const lease of leases) {
        // Every leased directory stays live — including the lease-only crash
        // window before the envelope lands, which may be another tab's
        // just-started upload.
        live.add(lease.fileId);
        try {
            const [envelope, checkpoint, parts] = await Promise.all([
                state.getEnvelope(lease.fileId),
                state.getCheckpoint(lease.fileId),
                state.getParts(lease.fileId),
            ]);
            if (!envelope) {
                continue;
            }
            const plan = planResume(lease, envelope, checkpoint, parts);
            if (plan.action === 'unrecoverable') {
                continue;
            }
            const action =
                plan.action === 'need-source'
                    ? plan.kind === 'multi'
                        ? 'need-source-multi'
                        : 'need-source-single'
                    : 'finish';
            // A handle is only useful (and only offered) when production needs
            // its single source back AND the facts to verify it survived [R13].
            const handle = action === 'need-source-single' ? lease.handles?.[0] : undefined;
            const handleFacts =
                action === 'need-source-single' ? lease.handleFacts?.[0] : undefined;
            candidates.push({
                fileId: lease.fileId,
                fileName:
                    envelope.manifest.length === 1
                        ? envelope.manifest[0].name
                        : (envelope.zipFilename ?? `${envelope.manifest.length} files`),
                size: envelope.manifest.reduce((sum, entry) => sum + entry.size, 0),
                encrypted: envelope.encrypted,
                secretKeyB64: envelope.secretKeyB64,
                timeLimit: envelope.timeLimit,
                downloadLimit: envelope.downloadLimit,
                createdAt: lease.createdAt,
                action,
                ...(handle && handleFacts && { handle, handleFacts }),
            });
        } catch {
            // Unreadable records: keep the staged bytes, offer nothing.
        }
    }
    await collectOrphanedStaging(live).catch(() => undefined);
    return candidates;
}

/**
 * Discard a persisted engine upload: best-effort server-side abort (the lease
 * holds the only uploadId/uploadToken copy), then clear engine state and the
 * OPFS staging directory. Never throws — the bucket lifecycle rule and the
 * startup GC reap anything a failed step leaves behind.
 */
export async function discardEngineUpload(fileId: string): Promise<void> {
    try {
        const state = await openEngineState();
        const lease = await state.getLease(fileId);
        if (lease) {
            await abortEngineUpload(fileId, lease.uploadId, lease.uploadToken).catch(
                () => undefined,
            );
        }
        await state.clearUpload(fileId);
    } catch {
        // best-effort — startup GC covers leftovers
    }
    await new OpfsPartStore(fileId).destroy().catch(() => undefined);
}

// Minimal structural OPFS surface (directory iteration works on the main
// thread; only sync access handles are worker-only).
interface MaintenanceDirectoryHandle {
    getDirectoryHandle(name: string): Promise<MaintenanceDirectoryHandle>;
    keys(): AsyncIterableIterator<string>;
}

async function listStagedUploadIds(): Promise<string[]> {
    const storage = globalThis.navigator?.storage;
    if (!storage || typeof storage.getDirectory !== 'function') {
        return [];
    }
    try {
        const root = (await storage.getDirectory()) as unknown as MaintenanceDirectoryHandle;
        const uploads = await root.getDirectoryHandle(UPLOADS_DIR);
        const ids: string[] = [];
        for await (const name of uploads.keys()) {
            ids.push(name);
        }
        return ids;
    } catch {
        return []; // no uploads directory → nothing staged
    }
}

/**
 * `true` when another context holds the `upload:<fileId>` Web Lock. An
 * `ifAvailable` grant is released immediately — this is a probe, not the
 * upload-lifetime lock (that one is held by the running upload itself).
 */
async function uploadLockHeldElsewhere(fileId: string): Promise<boolean> {
    const locks = globalThis.navigator?.locks;
    if (!locks || typeof locks.request !== 'function') {
        return false;
    }
    try {
        const held = await locks.request(
            `upload:${fileId}`,
            { ifAvailable: true },
            (lock) => lock === null,
        );
        return held === true;
    } catch {
        return true; // cannot verify → do not delete
    }
}

/** Delete `uploads/<id>` dirs with no lease and no live lock holder [R12]. */
async function collectOrphanedStaging(liveFileIds: Set<string>): Promise<void> {
    const staged = await listStagedUploadIds();
    const keep = new Set(liveFileIds);
    for (const id of staged) {
        if (!keep.has(id) && (await uploadLockHeldElsewhere(id))) {
            keep.add(id);
        }
    }
    if (staged.some((id) => !keep.has(id))) {
        await OpfsPartStore.gc(keep);
    }
}
