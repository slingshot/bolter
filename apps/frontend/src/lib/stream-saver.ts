/**
 * Streaming save targets for downloads that must be processed in the browser
 * (encrypted payloads, client-side zipping).
 *
 * Historically these downloads accumulated every decrypted byte into a
 * `Blob[]`, concatenated it into one Blob and handed that to
 * `URL.createObjectURL`. That bounds JS heap but not total retained bytes, so a
 * 20GB encrypted file — far below the advertised maximum — crashed the tab
 * before the file was ever saved.
 *
 * Instead, bytes go straight to disk through one of three writers, in
 * preference order:
 *
 *   1. `file-system-access` — `showSaveFilePicker()` +
 *      `FileSystemWritableFileStream` (Chrome/Edge). Nothing is retained; the
 *      file is only committed when `close()` succeeds.
 *   2. `service-worker` — the StreamSaver pattern, implemented in
 *      `public/download-stream-sw.js`: chunks are piped over a MessagePort to a
 *      narrowly scoped service worker which answers a hidden-iframe navigation
 *      with a `Content-Disposition: attachment` streaming response, so
 *      Safari/Firefox hand the bytes to the browser's download manager.
 *   3. `blob` — last resort only (no FSA, no service worker, or registration
 *      failed). Fully materializes, so it is size-capped and warns first.
 *
 * All three implement the same tiny {@link DownloadWriter} interface, which is
 * what makes the selection logic and each writer unit-testable without a real
 * browser.
 */

import { markSavedToDisk, triggerDownload } from './utils';

export type SaveStrategy = 'file-system-access' | 'service-worker' | 'blob';

/** Minimal sink contract shared by all three save strategies. */
export interface DownloadWriter {
    readonly strategy: SaveStrategy;
    write(chunk: Uint8Array): Promise<void>;
    /** Commit the file. Resolves only once the save has actually landed. */
    close(): Promise<void>;
    /** Discard the partially written file. Never throws. */
    abort(reason?: unknown): Promise<void>;
}

export interface SaveEnvironment {
    hasFileSystemAccess: boolean;
    hasServiceWorker: boolean;
    /** Service workers and `showSaveFilePicker` both require a secure context. */
    isSecureContext: boolean;
    /** Set once service-worker registration has been tried and failed. */
    serviceWorkerBroken: boolean;
}

export interface DownloadWriterOptions {
    filename: string;
    mimeType?: string;
    /** Expected output size in bytes; 0/undefined when unknown. */
    expectedSize?: number;
}

/** Injection seams so the selection logic is testable without a browser. */
export interface DownloadWriterDeps {
    env?: SaveEnvironment;
    confirm?: (message: string) => boolean;
    createFileSystemAccessWriter?: (o: DownloadWriterOptions) => Promise<DownloadWriter>;
    createServiceWorkerWriter?: (o: DownloadWriterOptions) => Promise<DownloadWriter>;
    createBlobWriter?: (o: DownloadWriterOptions) => DownloadWriter;
    onWarning?: (message: string) => void;
}

/**
 * Hard ceiling for the in-memory fallback. Above this the download is refused
 * outright rather than crashing the tab after transferring gigabytes.
 */
export const BLOB_FALLBACK_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Above this the user is warned that the fallback buffers the whole file. */
export const BLOB_FALLBACK_WARN_BYTES = 256 * 1024 * 1024; // 256 MiB

/** Path segment the service worker is scoped to. Must match the worker source. */
export const STREAM_PATH_SEGMENT = '_stream/';

/** Stable, unhashed URL for the worker script (lives in `public/`). */
export const STREAM_SW_FILENAME = 'download-stream-sw.js';

const SW_ACTIVATION_TIMEOUT = 15_000;
const SW_HANDSHAKE_TIMEOUT = 15_000;
const SW_CLOSE_TIMEOUT = 30_000;
/** Waiting forever on a credit would deadlock a download; degrade instead. */
const SW_CREDIT_TIMEOUT = 30_000;
const SW_KEEPALIVE_INTERVAL = 10_000;
/** Batch chunks before crossing the port so backpressure costs one hop per MiB. */
const SW_BATCH_BYTES = 1024 * 1024;
const BLOB_CONSOLIDATION_SIZE = 64 * 1024 * 1024;

/** Thrown when the user dismisses the save-file picker. */
export class SaveCancelledError extends Error {
    constructor(message = 'Save cancelled') {
        super(message);
        this.name = 'SaveCancelledError';
    }
}

/** Thrown when no streaming writer exists and the payload is too big to buffer. */
export class SaveTooLargeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SaveTooLargeError';
    }
}

const ssLog = (msg: string, data?: Record<string, unknown>) =>
    console.log(`[StreamSaver] ${msg}`, data ? data : '');

// ---------------------------------------------------------------------------
// Environment detection + strategy selection (pure)
// ---------------------------------------------------------------------------

let serviceWorkerBroken = false;

/** Test seam: forget a previous registration failure. */
export function resetServiceWorkerState(): void {
    serviceWorkerBroken = false;
    swRegistration = null;
}

export function detectSaveEnvironment(): SaveEnvironment {
    const win = typeof window === 'undefined' ? undefined : window;
    return {
        hasFileSystemAccess: !!win && typeof Reflect.get(win, 'showSaveFilePicker') === 'function',
        hasServiceWorker:
            typeof navigator !== 'undefined' &&
            'serviceWorker' in navigator &&
            typeof MessageChannel !== 'undefined',
        isSecureContext: typeof isSecureContext === 'undefined' ? true : isSecureContext,
        serviceWorkerBroken,
    };
}

/**
 * Pure preference order: stream to disk if we possibly can, buffer only when
 * the browser leaves us no choice.
 */
export function selectSaveStrategy(env: SaveEnvironment): SaveStrategy {
    if (env.hasFileSystemAccess && env.isSecureContext) {
        return 'file-system-access';
    }
    if (env.hasServiceWorker && env.isSecureContext && !env.serviceWorkerBroken) {
        return 'service-worker';
    }
    return 'blob';
}

export type BlobFallbackDecision =
    | { allowed: true; warning: string | null }
    | { allowed: false; reason: string };

/**
 * Gate for the memory-buffering fallback. Unknown sizes are warned about rather
 * than refused, because refusing them would break small downloads served
 * without a Content-Length.
 */
export function evaluateBlobFallback(expectedSize: number): BlobFallbackDecision {
    if (expectedSize > BLOB_FALLBACK_MAX_BYTES) {
        const gib = (expectedSize / (1024 * 1024 * 1024)).toFixed(1);
        const capGib = (BLOB_FALLBACK_MAX_BYTES / (1024 * 1024 * 1024)).toFixed(0);
        return {
            allowed: false,
            reason:
                `This browser cannot stream a ${gib} GB download to disk, and buffering it in ` +
                `memory would crash the tab (limit ${capGib} GB). Try Chrome or Edge, or ask ` +
                `the sender to split the file.`,
        };
    }
    if (expectedSize <= 0) {
        return {
            allowed: true,
            warning:
                'This browser cannot stream this download to disk, so it must be held in ' +
                'memory until it finishes. The size is unknown — a very large file may crash ' +
                'this tab. Continue?',
        };
    }
    if (expectedSize >= BLOB_FALLBACK_WARN_BYTES) {
        const mb = Math.round(expectedSize / (1024 * 1024));
        return {
            allowed: true,
            warning:
                `This browser cannot stream this download to disk, so all ${mb} MB must be ` +
                'held in memory until it finishes. On a low-memory device this can crash the ' +
                'tab. Continue?',
        };
    }
    return { allowed: true, warning: null };
}

// ---------------------------------------------------------------------------
// 1. File System Access API writer
// ---------------------------------------------------------------------------

interface FileSystemWritableLike {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
}

interface FileSystemFileHandleLike {
    createWritable(): Promise<FileSystemWritableLike>;
}

type SaveFilePicker = (options: { suggestedName?: string }) => Promise<FileSystemFileHandleLike>;

function isPickerCancellation(e: unknown): boolean {
    return e instanceof Error && e.name === 'AbortError';
}

/** A handle acquired during a click, waiting for the download to reach its sink. */
let preparedHandle: { handle: FileSystemFileHandleLike; at: number } | null = null;

/** How long a pre-acquired handle stays usable before it is dropped. */
export const PREPARED_HANDLE_TTL = 5 * 60 * 1000;

/**
 * Open the save picker eagerly, while the download click's transient user
 * activation is still live.
 *
 * `showSaveFilePicker` requires user activation, but the download sink is only
 * reached after metadata and signed-URL round trips have resolved — by which
 * point Chrome has usually revoked activation and the picker throws
 * `SecurityError`. Calling this from the click handler removes that race;
 * skipping it is safe, it just means Chrome degrades to the service-worker
 * writer more often.
 *
 * Returns false when the picker is unavailable or the user dismissed it.
 */
export async function prepareDiskSaveTarget(suggestedName: string): Promise<boolean> {
    const env = detectSaveEnvironment();
    if (!env.hasFileSystemAccess || !env.isSecureContext) {
        return false;
    }
    const picker = Reflect.get(window, 'showSaveFilePicker') as SaveFilePicker | undefined;
    if (typeof picker !== 'function') {
        return false;
    }
    try {
        const handle = await picker({ suggestedName });
        preparedHandle = { handle, at: Date.now() };
        return true;
    } catch (e) {
        ssLog('Could not pre-acquire a save location', {
            error: e instanceof Error ? e.message : String(e),
        });
        return false;
    }
}

/** Test seam: forget any pre-acquired save handle. */
export function clearPreparedSaveTarget(): void {
    preparedHandle = null;
}

function takePreparedHandle(): FileSystemFileHandleLike | null {
    const prepared = preparedHandle;
    preparedHandle = null;
    if (!prepared || Date.now() - prepared.at > PREPARED_HANDLE_TTL) {
        return null;
    }
    return prepared.handle;
}

export async function createFileSystemAccessWriter(
    options: DownloadWriterOptions,
): Promise<DownloadWriter> {
    let handle = takePreparedHandle();

    if (!handle) {
        const picker = Reflect.get(window, 'showSaveFilePicker') as SaveFilePicker | undefined;
        if (typeof picker !== 'function') {
            throw new Error('showSaveFilePicker unavailable');
        }
        // Deliberately no `types` filter: a mismatched accept map makes Chrome
        // rewrite the suggested extension.
        handle = await picker({ suggestedName: options.filename });
    }

    const writable = await handle.createWritable();

    return {
        strategy: 'file-system-access',
        write(chunk: Uint8Array): Promise<void> {
            return writable.write(chunk);
        },
        close(): Promise<void> {
            // Chrome writes to a swap file and only publishes it here — a
            // download that never reaches close() leaves no partial file.
            return writable.close();
        },
        async abort(reason?: unknown): Promise<void> {
            try {
                await writable.abort(reason);
            } catch {
                // Best effort — the swap file is discarded either way.
            }
        },
    };
}

// ---------------------------------------------------------------------------
// 2. Service-worker writer (StreamSaver pattern)
// ---------------------------------------------------------------------------

let swRegistration: Promise<ServiceWorker> | null = null;

function streamScopeUrl(): string {
    const base = String(import.meta.env?.BASE_URL ?? '/') || '/';
    return `${base.endsWith('/') ? base : `${base}/`}${STREAM_PATH_SEGMENT}`;
}

function swScriptUrl(): string {
    const base = String(import.meta.env?.BASE_URL ?? '/') || '/';
    return `${base.endsWith('/') ? base : `${base}/`}${STREAM_SW_FILENAME}`;
}

function waitForActivation(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
    if (registration.active) {
        return Promise.resolve(registration.active);
    }
    const worker = registration.installing || registration.waiting;
    if (!worker) {
        return Promise.reject(new Error('Service worker registration has no worker'));
    }
    const target: ServiceWorker = worker;
    return new Promise<ServiceWorker>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;

        const onChange = () => {
            if (target.state === 'activated') {
                clearTimeout(timer);
                target.removeEventListener('statechange', onChange);
                resolve(registration.active || target);
            } else if (target.state === 'redundant') {
                clearTimeout(timer);
                target.removeEventListener('statechange', onChange);
                reject(new Error('Service worker became redundant'));
            }
        };

        timer = setTimeout(() => {
            target.removeEventListener('statechange', onChange);
            reject(new Error('Service worker activation timed out'));
        }, SW_ACTIVATION_TIMEOUT);

        target.addEventListener('statechange', onChange);
        onChange();
    });
}

/**
 * Register lazily, on the first streamed download, and only for the dedicated
 * `_stream/` scope — the worker must never intercept the application's own
 * requests, and registering at app boot would cost every visitor a worker they
 * may never use.
 */
export function ensureStreamServiceWorker(): Promise<ServiceWorker> {
    if (!swRegistration) {
        swRegistration = (async () => {
            const registration = await navigator.serviceWorker.register(swScriptUrl(), {
                scope: streamScopeUrl(),
            });
            return waitForActivation(registration);
        })().catch((e) => {
            serviceWorkerBroken = true;
            swRegistration = null;
            throw e;
        });
    }
    return swRegistration;
}

function randomStreamId(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let id = '';
    for (const byte of bytes) {
        id += alphabet[byte % alphabet.length];
    }
    return id;
}

/** Just enough of `ServiceWorker` to hand the worker a port. */
export interface StreamWorkerLike {
    postMessage(message: unknown, transfer: Transferable[]): void;
}

export interface ServiceWorkerWriterDeps {
    /** Pre-resolved worker; defaults to the lazily registered stream worker. */
    worker?: StreamWorkerLike;
    /** Navigate into the worker's scope; returns a teardown callback. */
    openFrame?: (url: string) => () => void;
}

function openHiddenFrame(url: string): () => void {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);
    return () => {
        // The iframe has already handed its response to the download manager;
        // detaching it does not cancel an in-progress browser download.
        setTimeout(() => iframe.remove(), 60_000);
    };
}

export async function createServiceWorkerWriter(
    options: DownloadWriterOptions,
    deps: ServiceWorkerWriterDeps = {},
): Promise<DownloadWriter> {
    const worker: StreamWorkerLike = deps.worker ?? (await ensureStreamServiceWorker());
    const openFrame = deps.openFrame ?? openHiddenFrame;
    const id = randomStreamId();
    const channel = new MessageChannel();
    const port = channel.port1;

    let credits = 0;
    let creditWaiter: (() => void) | null = null;
    let failure: Error | null = null;
    let closedResolve: (() => void) | null = null;
    let cancelled = false;

    port.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg) {
            return;
        }
        if (msg.type === 'pull') {
            credits += 1;
            creditWaiter?.();
            return;
        }
        if (msg.type === 'closed') {
            closedResolve?.();
            return;
        }
        if (msg.type === 'cancelled') {
            cancelled = true;
            failure = new SaveCancelledError('Download cancelled in the browser');
            creditWaiter?.();
            closedResolve?.();
            return;
        }
        if (msg.type === 'error') {
            failure = new Error(`Download stream failed: ${msg.message}`);
            creditWaiter?.();
            closedResolve?.();
        }
    };
    port.start();

    // Handshake before navigating the iframe: the worker must already hold the
    // stream, otherwise the fetch falls through to the network and 404s.
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('Service worker did not acknowledge the download stream')),
            SW_HANDSHAKE_TIMEOUT,
        );
        const previous = port.onmessage;
        port.onmessage = (event: MessageEvent) => {
            if (event.data?.type === 'ready') {
                clearTimeout(timer);
                port.onmessage = previous;
                resolve();
                return;
            }
            previous?.call(port, event);
        };
        worker.postMessage(
            {
                type: 'bolter-stream-init',
                id,
                filename: options.filename,
                mimeType: options.mimeType,
            },
            [channel.port2],
        );
    });

    // Navigating a hidden iframe into the worker's scope makes the browser's
    // download manager the consumer of the piped stream.
    const closeFrame = openFrame(`${streamScopeUrl()}${id}`);

    const keepalive = setInterval(() => port.postMessage({ type: 'ping' }), SW_KEEPALIVE_INTERVAL);

    let batch = new Uint8Array(SW_BATCH_BYTES);
    let batchSize = 0;

    const teardown = () => {
        clearInterval(keepalive);
        port.onmessage = null;
        closeFrame();
    };

    const awaitCredit = async (): Promise<void> => {
        if (credits > 0 || failure) {
            return;
        }
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                creditWaiter = null;
                resolve();
            }, SW_CREDIT_TIMEOUT);
            creditWaiter = () => {
                clearTimeout(timer);
                creditWaiter = null;
                resolve();
            };
        });
    };

    const flush = async (): Promise<void> => {
        if (batchSize === 0) {
            return;
        }
        await awaitCredit();
        if (failure) {
            throw failure;
        }
        credits = Math.max(0, credits - 1);
        const buffer = batch.buffer as ArrayBuffer;
        const payload = batchSize === SW_BATCH_BYTES ? buffer : buffer.slice(0, batchSize);
        batch = new Uint8Array(SW_BATCH_BYTES);
        batchSize = 0;
        port.postMessage({ type: 'chunk', chunk: payload }, [payload]);
    };

    return {
        strategy: 'service-worker',
        async write(chunk: Uint8Array): Promise<void> {
            if (failure) {
                throw failure;
            }
            let offset = 0;
            while (offset < chunk.length) {
                const room = SW_BATCH_BYTES - batchSize;
                const take = Math.min(room, chunk.length - offset);
                batch.set(chunk.subarray(offset, offset + take), batchSize);
                batchSize += take;
                offset += take;
                if (batchSize === SW_BATCH_BYTES) {
                    await flush();
                }
            }
        },
        async close(): Promise<void> {
            try {
                await flush();
                if (failure) {
                    throw failure;
                }
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, SW_CLOSE_TIMEOUT);
                    closedResolve = () => {
                        clearTimeout(timer);
                        closedResolve = null;
                        resolve();
                    };
                    port.postMessage({ type: 'end' });
                });
                if (failure) {
                    throw failure;
                }
            } finally {
                teardown();
            }
        },
        abort(reason?: unknown): Promise<void> {
            try {
                if (!cancelled) {
                    port.postMessage({
                        type: 'abort',
                        reason: reason instanceof Error ? reason.message : String(reason ?? ''),
                    });
                }
            } catch {
                // Port already closed — nothing to signal.
            }
            teardown();
            return Promise.resolve();
        },
    };
}

// ---------------------------------------------------------------------------
// 3. In-memory Blob writer (last resort)
// ---------------------------------------------------------------------------

export function createBlobWriter(options: DownloadWriterOptions): DownloadWriter {
    const blobs: Blob[] = [];
    let pending: Uint8Array[] = [];
    let pendingSize = 0;
    let total = 0;

    return {
        strategy: 'blob',
        write(chunk: Uint8Array): Promise<void> {
            total += chunk.length;
            if (total > BLOB_FALLBACK_MAX_BYTES) {
                blobs.length = 0;
                pending = [];
                return Promise.reject(
                    new SaveTooLargeError(
                        `Download exceeded the ${Math.round(
                            BLOB_FALLBACK_MAX_BYTES / (1024 * 1024 * 1024),
                        )} GB in-memory limit for browsers that cannot stream to disk.`,
                    ),
                );
            }
            pending.push(chunk);
            pendingSize += chunk.length;
            if (pendingSize >= BLOB_CONSOLIDATION_SIZE) {
                blobs.push(new Blob(pending as BlobPart[]));
                pending = [];
                pendingSize = 0;
            }
            return Promise.resolve();
        },
        close(): Promise<void> {
            if (pending.length > 0) {
                blobs.push(new Blob(pending as BlobPart[]));
                pending = [];
                pendingSize = 0;
            }
            const blob = options.mimeType
                ? new Blob(blobs, { type: options.mimeType })
                : new Blob(blobs);
            blobs.length = 0;
            triggerDownload(blob, options.filename);
            return Promise.resolve();
        },
        abort(): Promise<void> {
            blobs.length = 0;
            pending = [];
            pendingSize = 0;
            return Promise.resolve();
        },
    };
}

// ---------------------------------------------------------------------------
// Writer selection
// ---------------------------------------------------------------------------

/**
 * Pick and open the best available save target. Falls back down the ladder when
 * a strategy is unavailable at runtime, but propagates an explicit user
 * cancellation instead of silently dropping to a worse strategy.
 */
export async function createDownloadWriter(
    options: DownloadWriterOptions,
    deps: DownloadWriterDeps = {},
): Promise<DownloadWriter> {
    const env = deps.env ?? detectSaveEnvironment();
    const fsaFactory = deps.createFileSystemAccessWriter ?? createFileSystemAccessWriter;
    const swFactory = deps.createServiceWorkerWriter ?? createServiceWorkerWriter;
    const blobFactory = deps.createBlobWriter ?? createBlobWriter;
    const strategy = selectSaveStrategy(env);

    if (strategy === 'file-system-access') {
        try {
            return await fsaFactory(options);
        } catch (e) {
            if (isPickerCancellation(e) || e instanceof SaveCancelledError) {
                throw new SaveCancelledError('Download cancelled: no save location was chosen.');
            }
            // Most commonly a SecurityError because the user activation from
            // the download click expired while metadata was fetched.
            ssLog('File System Access save unavailable, falling back', {
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    if (
        strategy !== 'blob' &&
        env.hasServiceWorker &&
        env.isSecureContext &&
        !env.serviceWorkerBroken
    ) {
        try {
            return await swFactory(options);
        } catch (e) {
            ssLog('Service-worker save unavailable, falling back to in-memory buffering', {
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    const decision = evaluateBlobFallback(options.expectedSize ?? 0);
    if (!decision.allowed) {
        throw new SaveTooLargeError(decision.reason);
    }
    if (decision.warning) {
        deps.onWarning?.(decision.warning);
        const ask =
            deps.confirm ??
            (typeof window === 'undefined' ? undefined : window.confirm.bind(window));
        if (ask && !ask(decision.warning)) {
            throw new SaveCancelledError('Download cancelled before buffering started.');
        }
    }
    return blobFactory(options);
}

/**
 * Placeholder returned to callers that still expect a Blob once the payload has
 * already been written to disk by a streaming writer.
 */
export function savedToDiskPlaceholder(): Blob {
    return markSavedToDisk(new Blob([]));
}
