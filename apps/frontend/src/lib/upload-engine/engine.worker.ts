/**
 * Dedicated-worker entry for the upload engine: wires real deps — the OPFS
 * part store, the engine IndexedDB state store, an XHR part transport (upload
 * progress events work in dedicated workers), and fetch-based API calls —
 * into `runEngine` / `executeResume`, and answers the client's eligibility
 * probe with a real 1-byte OPFS sync-access-handle round trip.
 *
 * One job per worker: the client spawns a fresh worker per upload, so the
 * scope closes itself once its job settles. Cancel is acknowledged from
 * inside the engine (`cancelled` is posted after the server-side abort,
 * before local cleanup); a cancel with nothing in flight is acked
 * immediately so the client never escalates a no-op to a terminate [R6].
 *
 * Worker-safe: no DOM globals — `self` is the dedicated worker scope (typed
 * structurally because this app compiles against the DOM lib).
 */

import { acquireUploadLock, UploadLockBusyError } from '../upload-lifecycle';
import { type EngineDeps, runEngine } from './engine';
import { OpfsPartStore } from './part-store';
import type {
    ClientToWorker,
    EngineProbeRequest,
    EngineProbeResult,
    WorkerToClient,
} from './protocol';
import { executeResume } from './resume';
import { type CompletionEnvelope, type EngineStateStore, openEngineState } from './state';
import type { UploadPartResult } from './uploader';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/** The DOM lib types `self` as `Window`; the worker surface is cast once. */
interface WorkerScope {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
}

const scope = self as unknown as WorkerScope;

const post = (message: WorkerToClient | EngineProbeResult): void => {
    scope.postMessage(message);
};

/** Connectivity relayed from the main thread; optimistic until told otherwise. */
let online = true;

let active: { fileId: string; controller: AbortController } | undefined;

scope.onmessage = (event: MessageEvent) => {
    void dispatch(event.data as ClientToWorker | EngineProbeRequest);
};

async function dispatch(message: ClientToWorker | EngineProbeRequest): Promise<void> {
    switch (message.type) {
        case 'probe':
            // The client owns (and terminates) probe workers — never close here.
            post(await runProbe());
            return;
        case 'start':
            await runJob(message.job.fileId, message.job.uploadId, (deps, cancel) =>
                runEngine(message.job, message.envelope, deps, cancel),
            );
            return;
        case 'resume':
            await runJob(message.fileId, undefined, (deps, cancel) =>
                executeResume(message.fileId, deps, cancel),
            );
            return;
        case 'cancel':
            if (active) {
                active.controller.abort();
            } else {
                post({ type: 'cancelled' });
            }
            return;
        case 'connectivity':
            online = message.online;
            return;
    }
}

async function runJob(
    fileId: string,
    knownUploadId: string | undefined,
    run: (deps: EngineDeps, cancel: AbortSignal) => Promise<unknown>,
): Promise<void> {
    if (active) {
        post({
            type: 'error',
            message: 'engine worker already has an active job',
            retryable: false,
            stage: 'engine',
        });
        return;
    }
    const controller = new AbortController();
    active = { fileId, controller };
    try {
        let deps: EngineDeps;
        try {
            deps = await buildDeps(fileId, knownUploadId);
        } catch (err) {
            post({
                type: 'error',
                message: err instanceof Error ? err.message : String(err),
                // An environment fault (IndexedDB unavailable, OPFS gone), not
                // a verdict on the upload — the caller may retry or fall back.
                retryable: true,
                stage: 'engine',
            });
            return;
        }
        // The `upload:<fileId>` Web Lock is held for the job's full lifetime
        // [R12]: startup GC in other tabs skips this upload's staging
        // directory, and a second context resuming the same upload is refused
        // instead of becoming a second writer. Coordination only — the lock
        // auto-releases if this worker is terminated; the durable lease stays
        // the source of truth.
        await acquireUploadLock(fileId, () => run(deps, controller.signal)).catch((err) => {
            if (err instanceof UploadLockBusyError) {
                // The engine never ran, so nothing posted a terminal event.
                // Retryable: the upload is alive in the other holder — this
                // attempt is redundant, not broken.
                post({ type: 'error', message: err.message, retryable: true, stage: 'engine' });
                return;
            }
            // Terminal events (`done` / `error` / `cancelled`) are posted by
            // the engine itself before this rejection surfaces.
        });
    } finally {
        active = undefined;
        scope.close();
    }
}

function buildDeps(fileId: string, knownUploadId: string | undefined): Promise<EngineDeps> {
    return openEngineState().then((state) => ({
        store: new OpfsPartStore(fileId),
        state,
        uploadPart: uploadPartXhr,
        completeUpload,
        refreshPartUrls: (id: string, uploadToken?: string) =>
            refreshPartUrls(state, id, uploadToken),
        abortUpload: (id: string, uploadToken?: string) =>
            abortUpload(state, id, knownUploadId, uploadToken),
        now: () => Date.now(),
        isOnline: () => online,
        onEvent: post,
    }));
}

/**
 * XHR part transport. Wall-clock stall detection lives in the uploader — this
 * transport only reports progress and honors the attempt's abort signal.
 * Error messages keep the `HTTP <status>` shape `isRetryableError` and the
 * uploader's 403 URL-expiry detection classify on.
 */
function uploadPartXhr(
    url: string,
    body: Blob,
    hooks: { onProgress(loaded: number): void; signal: AbortSignal },
): Promise<UploadPartResult> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const onAbort = () => xhr.abort();
        hooks.signal.addEventListener('abort', onAbort, { once: true });

        xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
                hooks.onProgress(event.loaded);
            }
        });

        // `loadend` is the single terminal event — it fires for success,
        // error (status 0 → "HTTP 0", retryable) and abort alike.
        xhr.addEventListener('loadend', () => {
            hooks.signal.removeEventListener('abort', onAbort);
            if (xhr.status >= 200 && xhr.status < 300) {
                const etag = xhr.getResponseHeader('ETag');
                if (!etag) {
                    // Without the ETag, CompleteMultipartUpload is guaranteed
                    // to fail after every byte has been uploaded — a bucket
                    // CORS misconfiguration (ETag missing from ExposeHeaders).
                    reject(
                        new Error(
                            'part uploaded but the ETag response header is not visible — check the bucket CORS ExposeHeaders configuration',
                        ),
                    );
                    return;
                }
                resolve({ etag });
                return;
            }
            if (hooks.signal.aborted) {
                // The uploader replaces transport-abort noise with the real
                // cause (stall or cancel).
                reject(new Error('Upload aborted'));
                return;
            }
            let details = `HTTP ${xhr.status}`;
            if (xhr.statusText) {
                details += ` (${xhr.statusText})`;
            }
            if (xhr.responseText) {
                details += `: ${xhr.responseText.substring(0, 200)}`;
            }
            reject(new Error(details));
        });

        xhr.open('PUT', url);
        xhr.send(body);
    });
}

/** Same `/upload/complete` contract as the legacy path: one-shot auth,
 * idempotent authKey retry, contiguous parts already validated upstream. */
async function completeUpload(
    envelope: CompletionEnvelope,
    parts: { PartNumber: number; ETag: string }[],
    actualSize: number,
): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/upload/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: envelope.fileId,
            metadata: envelope.metadata,
            ...(envelope.encrypted && { authKey: envelope.authKeyB64 }),
            actualSize,
            parts,
        }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
            `Failed to complete upload: HTTP ${response.status}${
                text ? `: ${text.substring(0, 200)}` : ''
            }`,
        );
    }
}

/**
 * Re-sign the remaining parts' URLs via `/upload/multipart/:id/resume`.
 * Returns the full index-0-=-part-1 array; already-uploaded parts keep an
 * empty slot the uploader never reads.
 */
async function refreshPartUrls(
    state: EngineStateStore,
    fileId: string,
    uploadToken?: string,
): Promise<string[]> {
    const lease = await state.getLease(fileId);
    if (!lease) {
        throw new Error(`cannot refresh part URLs: no engine lease for upload ${fileId}`);
    }
    const parts = await state.getParts(fileId);
    const completedPartNumbers = parts.filter((p) => p.uploaded).map((p) => p.partNumber);
    const response = await fetch(`${API_BASE_URL}/upload/multipart/${fileId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            uploadId: lease.uploadId,
            completedPartNumbers,
            ...(uploadToken !== undefined && { uploadToken }),
        }),
    });
    if (!response.ok) {
        throw new Error(`failed to refresh part URLs: HTTP ${response.status}`);
    }
    const info = (await response.json()) as {
        parts: { partNumber: number; url: string }[];
        numParts: number;
    };
    const maxPart = Math.max(info.numParts ?? 0, ...info.parts.map((p) => p.partNumber), 0);
    const urls = new Array<string>(maxPart).fill('');
    for (const part of info.parts) {
        urls[part.partNumber - 1] = part.url;
    }
    return urls;
}

/** Authenticated server-side abort; the uploadId comes from the running job
 * or, on a resume, from the persisted lease. */
async function abortUpload(
    state: EngineStateStore,
    fileId: string,
    knownUploadId: string | undefined,
    uploadToken?: string,
): Promise<void> {
    let uploadId = knownUploadId;
    if (!uploadId) {
        const lease = await state.getLease(fileId).catch(() => undefined);
        uploadId = lease?.uploadId;
    }
    if (!uploadId) {
        throw new Error(`cannot abort upload ${fileId}: no uploadId known`);
    }
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
// Eligibility probe
// ---------------------------------------------------------------------------

// Worker-only OPFS surface (createSyncAccessHandle) is absent from the DOM
// lib this app compiles against — typed structurally, cast at the boundary.
interface ProbeSyncHandle {
    write(buffer: Uint8Array, options?: { at?: number }): number;
    read(buffer: Uint8Array, options?: { at?: number }): number;
    flush(): void;
    close(): void;
}

interface ProbeFileHandle {
    createSyncAccessHandle(): Promise<ProbeSyncHandle>;
}

interface ProbeRootHandle {
    getFileHandle(name: string, opts?: { create?: boolean }): Promise<ProbeFileHandle>;
    removeEntry(name: string): Promise<void>;
}

/**
 * Real-capability probe: OPFS root → 1-byte sync-access-handle write/read
 * round trip → `storage.estimate()` (advisory only — quota can still fail
 * later). Probe files live at the OPFS root, outside the engine's `uploads/`
 * tree, and are removed before the result is posted.
 */
async function runProbe(): Promise<EngineProbeResult> {
    const fail = (reason: string): EngineProbeResult => ({
        type: 'probe-result',
        ok: false,
        reason,
    });
    try {
        const storage = globalThis.navigator?.storage;
        if (!storage || typeof storage.getDirectory !== 'function') {
            return fail('no-opfs');
        }
        const root = (await storage.getDirectory()) as unknown as ProbeRootHandle;
        const probeName = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
        try {
            const fileHandle = await root.getFileHandle(probeName, { create: true });
            const handle = await fileHandle.createSyncAccessHandle();
            let roundTripped = false;
            try {
                const written = handle.write(new Uint8Array([42]), { at: 0 });
                handle.flush();
                const buffer = new Uint8Array(1);
                const read = handle.read(buffer, { at: 0 });
                roundTripped = written === 1 && read === 1 && buffer[0] === 42;
            } finally {
                handle.close();
            }
            if (!roundTripped) {
                return fail('opfs-round-trip-failed');
            }
        } finally {
            await root.removeEntry(probeName).catch(() => undefined);
        }
        if (typeof storage.estimate === 'function') {
            try {
                await storage.estimate();
            } catch {
                // advisory only — an estimate failure is not a capability veto
            }
        }
        return { type: 'probe-result', ok: true };
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
