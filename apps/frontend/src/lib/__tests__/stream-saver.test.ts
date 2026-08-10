import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BLOB_FALLBACK_MAX_BYTES,
    BLOB_FALLBACK_WARN_BYTES,
    clearPreparedSaveTarget,
    createBlobWriter,
    createDownloadWriter,
    createFileSystemAccessWriter,
    createServiceWorkerWriter,
    type DownloadWriter,
    type DownloadWriterOptions,
    evaluateBlobFallback,
    prepareDiskSaveTarget,
    resetServiceWorkerState,
    SaveCancelledError,
    type SaveEnvironment,
    SaveTooLargeError,
    savedToDiskPlaceholder,
    selectSaveStrategy,
} from '@/lib/stream-saver';
import { isSavedToDisk, triggerDownload } from '@/lib/utils';

/**
 * Intercept the object-URL + anchor-click save so tests can assert whether a
 * download was triggered without happy-dom attempting a real navigation.
 */
function captureAnchorSaves() {
    const clicks: { href: string; download: string }[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:mock');
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function mockClick(this: HTMLAnchorElement) {
            clicks.push({ href: this.getAttribute('href') || '', download: this.download });
        });

    return {
        clicks,
        createObjectURL,
        restore() {
            clickSpy.mockRestore();
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
        },
    };
}

const env = (overrides: Partial<SaveEnvironment> = {}): SaveEnvironment => ({
    hasFileSystemAccess: false,
    hasServiceWorker: false,
    isSecureContext: true,
    serviceWorkerBroken: false,
    ...overrides,
});

function stubWriter(strategy: DownloadWriter['strategy']): DownloadWriter & {
    written: number;
    closed: boolean;
    aborted: boolean;
} {
    const w = {
        strategy,
        written: 0,
        closed: false,
        aborted: false,
        write(chunk: Uint8Array) {
            w.written += chunk.length;
            return Promise.resolve();
        },
        close() {
            w.closed = true;
            return Promise.resolve();
        },
        abort() {
            w.aborted = true;
            return Promise.resolve();
        },
    };
    return w;
}

describe('selectSaveStrategy', () => {
    it('prefers the File System Access API when it is available', () => {
        expect(selectSaveStrategy(env({ hasFileSystemAccess: true, hasServiceWorker: true }))).toBe(
            'file-system-access',
        );
    });

    it('falls back to the service worker when FSA is missing (Safari/Firefox)', () => {
        expect(selectSaveStrategy(env({ hasServiceWorker: true }))).toBe('service-worker');
    });

    it('skips the service worker once registration has failed', () => {
        expect(selectSaveStrategy(env({ hasServiceWorker: true, serviceWorkerBroken: true }))).toBe(
            'blob',
        );
    });

    it('never uses a streaming writer outside a secure context', () => {
        expect(
            selectSaveStrategy(
                env({
                    hasFileSystemAccess: true,
                    hasServiceWorker: true,
                    isSecureContext: false,
                }),
            ),
        ).toBe('blob');
    });

    it('buffers in memory only when nothing else is available', () => {
        expect(selectSaveStrategy(env())).toBe('blob');
    });
});

describe('evaluateBlobFallback', () => {
    it('allows small downloads silently', () => {
        expect(evaluateBlobFallback(10 * 1024 * 1024)).toEqual({ allowed: true, warning: null });
    });

    it('warns before buffering a large download', () => {
        const decision = evaluateBlobFallback(BLOB_FALLBACK_WARN_BYTES + 1);
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.warning).toContain('memory');
    });

    it('warns when the size is unknown', () => {
        const decision = evaluateBlobFallback(0);
        expect(decision.allowed).toBe(true);
        expect(decision.allowed && decision.warning).toContain('unknown');
    });

    it('refuses a payload above the in-memory cap instead of crashing the tab', () => {
        // The audit's scenario: a 20GB encrypted file on a browser that cannot
        // stream to disk. Pre-fix this was accepted and OOM'd mid-download.
        const decision = evaluateBlobFallback(20 * 1024 * 1024 * 1024);
        expect(decision.allowed).toBe(false);
        expect(!decision.allowed && decision.reason).toContain('cannot stream');
    });

    it('caps exactly at BLOB_FALLBACK_MAX_BYTES', () => {
        expect(evaluateBlobFallback(BLOB_FALLBACK_MAX_BYTES).allowed).toBe(true);
        expect(evaluateBlobFallback(BLOB_FALLBACK_MAX_BYTES + 1).allowed).toBe(false);
    });
});

describe('createDownloadWriter selection', () => {
    const options: DownloadWriterOptions = { filename: 'secret.bin', expectedSize: 1024 };

    it('uses the File System Access writer when available', async () => {
        const fsa = stubWriter('file-system-access');
        const sw = vi.fn();
        const writer = await createDownloadWriter(options, {
            env: env({ hasFileSystemAccess: true, hasServiceWorker: true }),
            createFileSystemAccessWriter: () => Promise.resolve(fsa),
            createServiceWorkerWriter: sw,
            createBlobWriter: () => stubWriter('blob'),
        });
        expect(writer).toBe(fsa);
        expect(sw).not.toHaveBeenCalled();
    });

    it('falls back to the service worker when the picker cannot be shown', async () => {
        // Chrome throws SecurityError when the click's transient user
        // activation expired while metadata/URL requests were in flight.
        const swWriter = stubWriter('service-worker');
        const securityError = new Error('Must be handling a user gesture');
        securityError.name = 'SecurityError';

        const writer = await createDownloadWriter(options, {
            env: env({ hasFileSystemAccess: true, hasServiceWorker: true }),
            createFileSystemAccessWriter: () => Promise.reject(securityError),
            createServiceWorkerWriter: () => Promise.resolve(swWriter),
            createBlobWriter: () => stubWriter('blob'),
        });
        expect(writer).toBe(swWriter);
    });

    it('propagates an explicit picker cancellation instead of silently buffering', async () => {
        const abortError = new Error('The user aborted a request.');
        abortError.name = 'AbortError';
        const blob = vi.fn();

        await expect(
            createDownloadWriter(options, {
                env: env({ hasFileSystemAccess: true, hasServiceWorker: true }),
                createFileSystemAccessWriter: () => Promise.reject(abortError),
                createServiceWorkerWriter: () => Promise.resolve(stubWriter('service-worker')),
                createBlobWriter: blob,
            }),
        ).rejects.toBeInstanceOf(SaveCancelledError);
        expect(blob).not.toHaveBeenCalled();
    });

    it('falls back to buffering when service-worker registration fails', async () => {
        const blobWriter = stubWriter('blob');
        const writer = await createDownloadWriter(options, {
            env: env({ hasServiceWorker: true }),
            createServiceWorkerWriter: () => Promise.reject(new Error('registration failed')),
            createBlobWriter: () => blobWriter,
        });
        expect(writer).toBe(blobWriter);
    });

    it('refuses to buffer an oversized payload when no streaming writer exists', async () => {
        await expect(
            createDownloadWriter(
                { filename: 'huge.bin', expectedSize: 20 * 1024 * 1024 * 1024 },
                { env: env(), createBlobWriter: () => stubWriter('blob') },
            ),
        ).rejects.toBeInstanceOf(SaveTooLargeError);
    });

    it('warns the user before starting a large buffered download', async () => {
        const confirm = vi.fn(() => true);
        const onWarning = vi.fn();
        const blobWriter = stubWriter('blob');

        const writer = await createDownloadWriter(
            { filename: 'big.bin', expectedSize: BLOB_FALLBACK_WARN_BYTES * 2 },
            { env: env(), confirm, onWarning, createBlobWriter: () => blobWriter },
        );

        expect(writer).toBe(blobWriter);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(onWarning).toHaveBeenCalledTimes(1);
    });

    it('aborts before any bytes are buffered when the user declines the warning', async () => {
        const blob = vi.fn();
        await expect(
            createDownloadWriter(
                { filename: 'big.bin', expectedSize: BLOB_FALLBACK_WARN_BYTES * 2 },
                { env: env(), confirm: () => false, createBlobWriter: blob },
            ),
        ).rejects.toBeInstanceOf(SaveCancelledError);
        expect(blob).not.toHaveBeenCalled();
    });

    it('does not prompt for a small buffered download', async () => {
        const confirm = vi.fn(() => true);
        await createDownloadWriter(
            { filename: 'small.bin', expectedSize: 1024 },
            { env: env(), confirm, createBlobWriter: () => stubWriter('blob') },
        );
        expect(confirm).not.toHaveBeenCalled();
    });
});

describe('createFileSystemAccessWriter', () => {
    let originalPicker: unknown;

    beforeEach(() => {
        originalPicker = Reflect.get(window, 'showSaveFilePicker');
        clearPreparedSaveTarget();
    });

    afterEach(() => {
        clearPreparedSaveTarget();
        if (originalPicker === undefined) {
            Reflect.deleteProperty(window, 'showSaveFilePicker');
        } else {
            Reflect.set(window, 'showSaveFilePicker', originalPicker);
        }
    });

    function installPicker() {
        const writes: Uint8Array[] = [];
        const writable = {
            write: vi.fn((data: Uint8Array) => {
                writes.push(data);
                return Promise.resolve();
            }),
            close: vi.fn(() => Promise.resolve()),
            abort: vi.fn(() => Promise.resolve()),
        };
        const picker = vi.fn(() =>
            Promise.resolve({ createWritable: () => Promise.resolve(writable) }),
        );
        Reflect.set(window, 'showSaveFilePicker', picker);
        return { writes, writable, picker };
    }

    it('streams every chunk to the writable and only commits on close', async () => {
        const { writes, writable, picker } = installPicker();
        const writer = await createFileSystemAccessWriter({ filename: 'video.mov' });

        expect(picker).toHaveBeenCalledWith({ suggestedName: 'video.mov' });
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.write(new Uint8Array([4, 5]));

        // The bytes are on disk already — nothing is retained by the writer.
        expect(writes.map((c) => [...c])).toEqual([
            [1, 2, 3],
            [4, 5],
        ]);
        expect(writable.close).not.toHaveBeenCalled();

        await writer.close();
        expect(writable.close).toHaveBeenCalledTimes(1);
    });

    it('reuses a handle pre-acquired during the click instead of re-prompting', async () => {
        const { picker, writable } = installPicker();

        // Chrome revokes transient user activation while metadata/URL requests
        // are in flight, so the picker has to be opened from the click handler.
        await expect(prepareDiskSaveTarget('video.mov')).resolves.toBe(true);
        expect(picker).toHaveBeenCalledTimes(1);

        const writer = await createFileSystemAccessWriter({ filename: 'video.mov' });
        expect(picker).toHaveBeenCalledTimes(1); // not prompted a second time

        await writer.write(new Uint8Array([1]));
        await writer.close();
        expect(writable.close).toHaveBeenCalledTimes(1);
    });

    it('reports a dismissed pre-acquisition without throwing', async () => {
        const abortError = new Error('user dismissed');
        abortError.name = 'AbortError';
        const picker = vi.fn(() => Promise.reject(abortError));
        Reflect.set(window, 'showSaveFilePicker', picker);

        await expect(prepareDiskSaveTarget('video.mov')).resolves.toBe(false);
    });

    it('does not pre-acquire when the API is unavailable', async () => {
        Reflect.deleteProperty(window, 'showSaveFilePicker');
        await expect(prepareDiskSaveTarget('video.mov')).resolves.toBe(false);
    });

    it('discards the swap file on abort and never throws', async () => {
        const { writable } = installPicker();
        writable.abort.mockRejectedValueOnce(new Error('already closed'));
        const writer = await createFileSystemAccessWriter({ filename: 'video.mov' });

        await expect(writer.abort(new Error('truncated'))).resolves.toBeUndefined();
        expect(writable.abort).toHaveBeenCalledTimes(1);
    });
});

describe('createBlobWriter', () => {
    it('saves nothing until close, then triggers exactly one download', async () => {
        const saves = captureAnchorSaves();
        try {
            const writer = createBlobWriter({ filename: 'notes.txt', mimeType: 'text/plain' });
            await writer.write(new Uint8Array([1, 2]));
            expect(saves.createObjectURL).not.toHaveBeenCalled();

            await writer.close();
            expect(saves.createObjectURL).toHaveBeenCalledTimes(1);
            expect(saves.clicks).toEqual([{ href: 'blob:mock', download: 'notes.txt' }]);
        } finally {
            saves.restore();
        }
    });

    it('drops everything buffered on abort so nothing is saved', async () => {
        const saves = captureAnchorSaves();
        try {
            const writer = createBlobWriter({ filename: 'notes.txt' });
            await writer.write(new Uint8Array([1, 2]));
            await writer.abort();
            expect(saves.clicks).toEqual([]);
        } finally {
            saves.restore();
        }
    });

    it('fails mid-stream once the payload exceeds the in-memory cap', async () => {
        const writer = createBlobWriter({ filename: 'huge.bin' });

        // Normal chunks stream through untouched...
        await expect(writer.write(new Uint8Array(1024))).resolves.toBeUndefined();

        // ...but a payload that would blow past the cap is refused mid-stream
        // rather than retained until the tab dies. (Length is faked so the test
        // does not actually allocate gigabytes.)
        const overflow = { length: BLOB_FALLBACK_MAX_BYTES } as unknown as Uint8Array;
        await expect(writer.write(overflow)).rejects.toBeInstanceOf(SaveTooLargeError);
    });
});

describe('createServiceWorkerWriter', () => {
    beforeEach(() => {
        resetServiceWorkerState();
    });

    /**
     * Stands in for public/download-stream-sw.js: accepts the transferred port,
     * acknowledges the handshake, grants one credit per chunk and acknowledges
     * the close.
     */
    function fakeWorker() {
        const received: Uint8Array[] = [];
        let ended = false;
        let aborted = false;

        const worker = {
            postMessage(_message: unknown, transfer: Transferable[]) {
                const port = transfer[0] as MessagePort;
                port.onmessage = (event: MessageEvent) => {
                    const msg = event.data;
                    if (msg.type === 'chunk') {
                        received.push(new Uint8Array(msg.chunk));
                        port.postMessage({ type: 'pull' });
                        return;
                    }
                    if (msg.type === 'end') {
                        ended = true;
                        port.postMessage({ type: 'closed' });
                        return;
                    }
                    if (msg.type === 'abort') {
                        aborted = true;
                        port.postMessage({ type: 'aborted' });
                    }
                };
                port.start();
                // Initial credit + handshake, mirroring the worker's pull()
                port.postMessage({ type: 'pull' });
                port.postMessage({ type: 'ready' });
            },
        };

        return {
            worker,
            get received() {
                return received;
            },
            get ended() {
                return ended;
            },
            get aborted() {
                return aborted;
            },
        };
    }

    it('streams chunks over the port and navigates a frame into the worker scope', async () => {
        const sw = fakeWorker();
        const opened: string[] = [];
        let frameClosed = false;

        const writer = await createServiceWorkerWriter(
            { filename: 'movie.mkv', mimeType: 'video/x-matroska' },
            {
                worker: sw.worker,
                openFrame: (url) => {
                    opened.push(url);
                    return () => {
                        frameClosed = true;
                    };
                },
            },
        );

        expect(writer.strategy).toBe('service-worker');
        expect(opened).toHaveLength(1);
        expect(opened[0]).toContain('/_stream/');

        await writer.write(new Uint8Array([9, 8, 7]));
        await writer.close();

        const delivered = sw.received.flatMap((c) => [...c]);
        expect(delivered).toEqual([9, 8, 7]);
        expect(sw.ended).toBe(true);
        expect(frameClosed).toBe(true);
    });

    it('signals the worker to discard the stream on abort', async () => {
        const sw = fakeWorker();
        const writer = await createServiceWorkerWriter(
            { filename: 'movie.mkv' },
            { worker: sw.worker, openFrame: () => () => undefined },
        );

        await writer.write(new Uint8Array([1]));
        await writer.abort(new Error('truncated'));
        await new Promise((r) => setTimeout(r, 0));
        expect(sw.aborted).toBe(true);
        expect(sw.ended).toBe(false);
    });
});

describe('savedToDiskPlaceholder', () => {
    it('is an empty Blob that triggerDownload refuses to save', () => {
        const placeholder = savedToDiskPlaceholder();
        expect(placeholder.size).toBe(0);
        expect(isSavedToDisk(placeholder)).toBe(true);

        const saves = captureAnchorSaves();
        try {
            triggerDownload(placeholder, 'movie.mkv');
            // Pre-fix, downloadFile returned the real payload Blob and this
            // call was the save. Now the bytes are already on disk, so saving
            // the placeholder would replace the real file with an empty one.
            expect(saves.createObjectURL).not.toHaveBeenCalled();
            expect(saves.clicks).toEqual([]);

            // A genuine payload Blob is still saved the old way.
            triggerDownload(new Blob(['data']), 'notes.txt');
            expect(saves.clicks).toEqual([{ href: 'blob:mock', download: 'notes.txt' }]);
        } finally {
            saves.restore();
        }
    });
});
