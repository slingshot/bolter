/**
 * Shared helpers for the worker-engine Playwright suite.
 *
 * The suite runs against the production build with no backend: every API
 * endpoint the upload pipeline touches — and the "S3" part URLs the mocked
 * allocation hands out — is answered by `page.route` handlers registered
 * here. The build bakes `VITE_API_URL = <preview origin>/api`, so all mocked
 * traffic is same-origin: no CORS preflights to emulate, and the worker's
 * XHR can read the mocked `ETag` response header without `ExposeHeaders`.
 */

import type { Page, Route } from '@playwright/test';

export const PREVIEW_ORIGIN = 'http://localhost:4173';

/** Nominal part size handed out by the mocked `/upload/url` allocation. */
export const PART_SIZE = 64 * 1024 * 1024;

export interface CompletionRequest {
    id: string;
    metadata: string;
    authKey?: string;
    actualSize: number;
    parts?: { PartNumber: number; ETag: string }[];
}

export interface MockBackend {
    readonly fileId: string;
    readonly partSize: number;
    /** Completed (fulfilled) PUTs per part number — held PUTs never count. */
    readonly putCounts: Map<number, number>;
    /** Body size of each completed PUT per part number (-1 if unavailable). */
    readonly putSizes: Map<number, number[]>;
    /** Parsed `/upload/complete` request bodies, in arrival order. */
    readonly completions: CompletionRequest[];
    /** Number of `/upload/multipart/:id/resume` calls. */
    resumeCalls: number;
    /** Stop holding PUTs: answer everything pending and everything future. */
    releaseHeldParts(): void;
}

export interface MockBackendOptions {
    fileId?: string;
    partSize?: number;
    /** Part numbers whose PUTs are left unanswered until `releaseHeldParts`. */
    holdParts?: number[];
}

const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
});

const CONFIG_RESPONSE = {
    LIMITS: {
        MAX_FILE_SIZE: 1_000_000_000_000,
        MAX_FILES_PER_ARCHIVE: 64,
        MAX_EXPIRE_SECONDS: 86_400 * 180,
        MAX_DOWNLOADS: 100,
    },
    DEFAULTS: {
        EXPIRE_SECONDS: 86_400,
        DOWNLOADS: 1,
    },
    UI: {
        EXPIRE_TIMES: [300, 3600, 86_400, 604_800],
        DOWNLOAD_COUNTS: [1, 2, 3, 4, 5],
        TITLE: 'Bolter E2E',
        DESCRIPTION: 'Playwright suite',
    },
};

/**
 * Install the mocked backend + S3 on `page`. Routes persist across reloads,
 * so a single install covers interrupted-upload/resume scenarios; the closure
 * keeps allocation state (part count) alive across the reload too.
 */
export async function installMockBackend(
    page: Page,
    options: MockBackendOptions = {},
): Promise<MockBackend> {
    const fileId = options.fileId ?? 'e2efile1';
    const partSize = options.partSize ?? PART_SIZE;
    const held = new Set(options.holdParts ?? []);
    let holdsActive = held.size > 0;
    const pendingHeld: { route: Route; partNumber: number }[] = [];
    let allocatedParts = 0;

    const state: MockBackend = {
        fileId,
        partSize,
        putCounts: new Map(),
        putSizes: new Map(),
        completions: [],
        resumeCalls: 0,
        releaseHeldParts() {
            holdsActive = false;
            for (const pending of pendingHeld.splice(0)) {
                // Held PUTs belong to an interrupted run (the page navigated
                // away mid-flight). Abort rather than fulfill: a late fulfill
                // can still "succeed" against a dead request and would count a
                // PUT the app never observed.
                void pending.route.abort('failed').catch(() => undefined);
            }
        },
    };

    const partUrl = (partNumber: number) => `${PREVIEW_ORIGIN}/s3/${fileId}/${partNumber}`;
    const partList = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
            partNumber: i + 1,
            url: partUrl(i + 1),
            minSize: 0,
            maxSize: 5 * 1024 * 1024 * 1024,
        }));

    const fulfillPut = async (route: Route, partNumber: number): Promise<void> => {
        // Intercepted requests carry no Content-Length header, so the staged
        // body itself is the size source of truth. WebKit buffers no post data
        // for intercepted requests and sends no Content-Length either, so this
        // is `-1` for the whole WebKit project — see `PART_SIZES_OBSERVABLE`.
        const bodyBytes = route.request().postDataBuffer()?.byteLength ?? -1;
        await route.fulfill({
            status: 200,
            headers: { ETag: `"etag-${partNumber}"` },
            body: '',
        });
        state.putCounts.set(partNumber, (state.putCounts.get(partNumber) ?? 0) + 1);
        const sizes = state.putSizes.get(partNumber) ?? [];
        sizes.push(bodyBytes);
        state.putSizes.set(partNumber, sizes);
    };

    // Catch-all first: Playwright consults handlers in reverse registration
    // order, so the specific routes below win over this one.
    await page.route('**/api/**', (route) => route.fulfill(json({ error: 'unmocked' }, 404)));
    await page.route('**/api/config', (route) => route.fulfill(json(CONFIG_RESPONSE)));
    await page.route('**/api/pl/api/event', (route) => route.fulfill({ status: 202, body: '' }));
    // No speed-test part URLs → `measureUploadSpeed` reports 0 immediately
    // and the pipeline falls back to the allocation's part size (which this
    // mock dictates anyway) instead of pushing 500MB of throwaway bytes.
    await page.route('**/api/upload/speedtest', (route) =>
        route.fulfill(
            json({ testId: 'e2e-speedtest', uploadId: 'e2e-speedtest-upload', parts: [] }),
        ),
    );
    await page.route('**/api/upload/speedtest/cleanup', (route) =>
        route.fulfill(json({ ok: true })),
    );
    await page.route('**/api/upload/url', (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}') as { fileSize?: number };
        const fileSize = body.fileSize ?? 0;
        allocatedParts = Math.max(1, Math.ceil(fileSize / partSize));
        return route.fulfill(
            json({
                useSignedUrl: true,
                multipart: true,
                id: fileId,
                owner: 'e2e-owner-token',
                uploadId: 'e2e-upload-id',
                uploadToken: 'e2e-upload-token',
                partSize,
                url: '',
                parts: partList(allocatedParts),
            }),
        );
    });
    await page.route('**/api/upload/complete', (route) => {
        state.completions.push(JSON.parse(route.request().postData() ?? '{}'));
        return route.fulfill(json({ ok: true }));
    });
    await page.route('**/api/upload/multipart/**', (route) => {
        state.resumeCalls += 1;
        return route.fulfill(json({ numParts: allocatedParts, parts: partList(allocatedParts) }));
    });
    await page.route('**/api/upload/abort/**', (route) => route.fulfill(json({ ok: true })));

    await page.route('**/s3/**', async (route) => {
        if (route.request().method() !== 'PUT') {
            await route.fulfill({ status: 405, body: '' });
            return;
        }
        const partNumber = Number(new URL(route.request().url()).pathname.split('/').pop());
        if (holdsActive && held.has(partNumber)) {
            pendingHeld.push({ route, partNumber });
            return; // deliberately unanswered until releaseHeldParts()
        }
        await fulfillPut(route, partNumber);
    });

    return state;
}

/**
 * Generate a payload File in page context and feed it through the DropZone's
 * hidden `#file-input`, exactly as a user pick would. The bytes carry a
 * sparse deterministic pattern so generation stays cheap at 150MB.
 */
export async function addGeneratedFile(page: Page, name: string, sizeBytes: number): Promise<void> {
    await page.evaluate(
        ({ name: fileName, sizeBytes: size }) => {
            const bytes = new Uint8Array(size);
            for (let i = 0; i < bytes.length; i += 4096) {
                bytes[i] = i % 251;
            }
            const file = new File([bytes], fileName, {
                type: 'application/octet-stream',
                lastModified: 1_700_000_000_000,
            });
            const input = document.getElementById('file-input') as HTMLInputElement | null;
            if (!input) {
                throw new Error('#file-input not found — is the DropZone rendered?');
            }
            const transfer = new DataTransfer();
            transfer.items.add(file);
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        },
        { name, sizeBytes },
    );
}

/**
 * Record every `Worker` spawn URL on the page (must be installed before
 * navigation). The engine's worker chunk keeps `engine.worker` in its built
 * filename, so tests can tell engine spawns from any other worker.
 */
export async function installWorkerSpy(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const spawns: string[] = [];
        (window as unknown as { __workerSpawns: string[] }).__workerSpawns = spawns;
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(url: string | URL, opts?: WorkerOptions) {
                super(url, opts);
                spawns.push(String(url));
            }
        };
    });
}

export function workerSpawns(page: Page): Promise<string[]> {
    return page.evaluate(
        () => (window as unknown as { __workerSpawns?: string[] }).__workerSpawns ?? [],
    );
}

/**
 * Telemetry events captured by the Vercel Analytics queue. The insights
 * script 404s under `vite preview`, so `window.vaq` retains every event the
 * app emitted — a deterministic, network-free view of upload telemetry.
 */
export function analyticsEvents(
    page: Page,
): Promise<{ name: string; data?: Record<string, string> }[]> {
    return page.evaluate(() => {
        const queue = (window as unknown as { vaq?: unknown[][] }).vaq ?? [];
        return queue
            .filter((entry) => entry[0] === 'event')
            .map((entry) => entry[1] as { name: string; data?: Record<string, string> });
    });
}

/** The engine's persisted producer checkpoint for `fileId`, if any. */
export function readEngineCheckpoint(
    page: Page,
    fileId: string,
): Promise<{ eofReached: boolean; nextPartNumber: number } | undefined> {
    return page.evaluate(async (id) => {
        const existing = await indexedDB.databases();
        if (!existing.some((db) => db.name === 'bolter-upload-engine')) {
            return undefined;
        }
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('bolter-upload-engine');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            if (!db.objectStoreNames.contains('checkpoints')) {
                return undefined;
            }
            return await new Promise((resolve, reject) => {
                const request = db
                    .transaction('checkpoints', 'readonly')
                    .objectStore('checkpoints')
                    .get(id);
                request.onsuccess = () =>
                    resolve(
                        request.result as
                            | { eofReached: boolean; nextPartNumber: number }
                            | undefined,
                    );
                request.onerror = () => reject(request.error);
            });
        } finally {
            db.close();
        }
    }, fileId);
}

/** Names of `uploads/<fileId>` staging directories currently in OPFS. */
export function listOpfsUploadDirs(page: Page): Promise<string[]> {
    return page.evaluate(async () => {
        if (typeof navigator.storage?.getDirectory !== 'function') {
            return [];
        }
        const root = await navigator.storage.getDirectory();
        let uploads: FileSystemDirectoryHandle;
        try {
            uploads = await root.getDirectoryHandle('uploads');
        } catch {
            return [];
        }
        const names: string[] = [];
        const iterable = uploads as unknown as { keys(): AsyncIterableIterator<string> };
        for await (const name of iterable.keys()) {
            names.push(name);
        }
        return names;
    });
}
