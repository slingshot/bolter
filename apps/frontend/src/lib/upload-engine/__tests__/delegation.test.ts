import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkedFile, FakeXhr, multipartUploadInfo } from '@/lib/__tests__/upload-xhr-fake';
import type { PersistedUpload } from '@/lib/upload-state';
import { currentUploadAttempt, resetEligibilityCacheForTests, setWorkerFactory } from '../client';
import type { ClientToWorker, EngineProbeResult, WorkerToClient } from '../protocol';
import { openEngineState } from '../state';

// Non-WebKit UA so the legacy fallback selects the stream-based multipart
// path. `isWebKit` is computed once at api.ts module load, so the stub must
// precede the import.
const navigatorStub = {
    userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    onLine: true,
};
vi.stubGlobal('navigator', navigatorStub);

// The engine client emits telemetry through @/lib/plausible; mock it so no
// analytics traffic can reach the fetch stub these tests assert against.
vi.mock('@/lib/plausible', () => ({
    newUploadAttemptId: () => 'ua_testattemptid',
    trackEngineEvent: vi.fn(),
    trackUploadAttempt: vi.fn(),
}));

const { uploadFiles, resumeUpload, Canceller } = await import('@/lib/api');
const { Keychain } = await import('@/lib/crypto');
const { getConcurrentUploads } = await import('@/lib/upload-shared');

const MB = 1024 * 1024;

type ProbeMessage = { type: 'probe' };
type AnyClientMessage = ClientToWorker | ProbeMessage;

/**
 * Fake engine worker installed via `setWorkerFactory`. Answers the
 * eligibility probe with success and hands `start`/`resume` jobs to the
 * test-controlled `onJob` hook.
 */
class FakeEngineWorker {
    static instances: FakeEngineWorker[] = [];
    static onJob: ((worker: FakeEngineWorker, message: ClientToWorker) => void) | undefined;

    static reset() {
        FakeEngineWorker.instances = [];
        FakeEngineWorker.onJob = undefined;
    }

    static postedMessages(): AnyClientMessage[] {
        return FakeEngineWorker.instances.flatMap((w) => w.posted);
    }

    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    posted: AnyClientMessage[] = [];
    terminated = false;

    constructor() {
        FakeEngineWorker.instances.push(this);
    }

    postMessage(message: AnyClientMessage): void {
        this.posted.push(message);
        if (message.type === 'probe') {
            queueMicrotask(() =>
                this.emit({ type: 'probe-result', ok: true } satisfies EngineProbeResult),
            );
        } else if (message.type === 'start' || message.type === 'resume') {
            queueMicrotask(() => FakeEngineWorker.onJob?.(this, message));
        }
    }

    terminate(): void {
        this.terminated = true;
    }

    emit(message: WorkerToClient | EngineProbeResult): void {
        this.onmessage?.({ data: message });
    }
}

function makeFile(bytes: number, declaredSize?: number, name = 'big.bin'): File {
    const file = new File([new Uint8Array(bytes)], name, {
        type: 'application/octet-stream',
        lastModified: 1700000000000,
    });
    if (declaredSize !== undefined) {
        Object.defineProperty(file, 'size', { value: declaredSize });
    }
    return file;
}

function makeLegacyState(fileId: string): PersistedUpload {
    return {
        fileId,
        uploadId: 'legacy-upload-id',
        ownerToken: 'legacy-owner',
        fileName: 'x.bin',
        fileSize: 4,
        fileLastModified: 1700000000000,
        contentFingerprint: 'fp',
        encrypted: false,
        partSize: 10 * MB,
        plaintextPartSize: 10 * MB,
        completedParts: [],
        totalParts: 1,
        timeLimit: 86400,
        downloadLimit: 1,
        createdAt: Date.now(),
    };
}

function deleteDatabase(name: string): Promise<void> {
    return new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}

describe('engine delegation in uploadFiles', () => {
    let fetchCalls: string[];
    let uploadUrlBodies: Record<string, unknown>[];
    let uploadUrlResponse: Record<string, unknown>;

    beforeEach(async () => {
        await deleteDatabase('bolter-uploads');
        await deleteDatabase('bolter-upload-engine');

        navigatorStub.onLine = true;
        vi.stubGlobal('navigator', navigatorStub);
        localStorage.removeItem('bolter:upload-engine');
        FakeXhr.reset();
        vi.stubGlobal('XMLHttpRequest', FakeXhr);
        FakeEngineWorker.reset();
        // The capability verdict is cached for the session — each test needs
        // its own probe, not the previous test's.
        resetEligibilityCacheForTests();
        // happy-dom has no Worker global; the probe's capability check only
        // needs it to exist — actual spawning goes through the factory.
        vi.stubGlobal('Worker', FakeEngineWorker);
        setWorkerFactory(() => new FakeEngineWorker() as unknown as Worker);

        uploadUrlResponse = multipartUploadInfo(15, 10 * MB);
        fetchCalls = [];
        uploadUrlBodies = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit) => {
                const u = String(url);
                fetchCalls.push(u);
                // Speed test declined → measureUploadSpeed returns 0 quickly
                if (u.includes('/upload/speedtest')) {
                    return Promise.resolve(new Response('nope', { status: 500 }));
                }
                if (u.includes('/upload/url')) {
                    uploadUrlBodies.push(JSON.parse(String(init?.body)));
                    return Promise.resolve(
                        new Response(JSON.stringify(uploadUrlResponse), { status: 200 }),
                    );
                }
                if (u.includes('/upload/complete')) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ success: true, id: 'file-id', url: 'x' }), {
                            status: 200,
                        }),
                    );
                }
                if (u.includes('/upload/abort/') || u.includes('/delete/')) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ success: true }), { status: 200 }),
                    );
                }
                return Promise.reject(new Error(`Unexpected fetch: ${u}`));
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('routes an eligible multipart-sized upload through the engine worker', async () => {
        uploadUrlResponse = { ...multipartUploadInfo(15, 10 * MB), uploadToken: 'upload-token-1' };
        FakeEngineWorker.onJob = (worker, message) => {
            if (message.type === 'start') {
                worker.emit({ type: 'done', actualSize: message.job.declaredTotalSize });
            }
        };

        const declaredSize = 150 * MB;
        const file = makeFile(1024, declaredSize);
        const keychain = new Keychain();

        const result = await uploadFiles(
            { files: [file], encrypted: false },
            keychain,
            new Canceller(),
        );

        const start = FakeEngineWorker.postedMessages().find((m) => m.type === 'start');
        expect(start).toBeDefined();
        if (start?.type !== 'start') {
            throw new Error('unreachable');
        }

        // Job fields come from the mocked /upload/url response
        expect(start.job.fileId).toBe('file-id');
        expect(start.job.uploadId).toBe('upload-id');
        expect(start.job.uploadToken).toBe('upload-token-1');
        expect(start.job.ownerToken).toBe('owner-token');
        expect(start.job.partUrls).toEqual(
            Array.from({ length: 15 }, (_, i) => `https://s3.example.com/part${i + 1}`),
        );
        expect(start.job.partSize).toBe(10 * MB); // unencrypted: effective = raw
        expect(start.job.encrypted).toBe(false);
        expect(start.job.declaredTotalSize).toBe(declaredSize);
        expect(start.job.maxConcurrent).toBe(getConcurrentUploads(declaredSize));
        expect(start.job.source).toEqual({ kind: 'file', file });

        // Envelope matches the metadata the legacy completion would send
        const expectedMetadata = btoa(
            unescape(
                encodeURIComponent(
                    JSON.stringify({
                        files: [
                            {
                                name: 'big.bin',
                                size: declaredSize,
                                type: 'application/octet-stream',
                            },
                        ],
                    }),
                ),
            ),
        );
        expect(start.envelope.fileId).toBe('file-id');
        expect(start.envelope.metadata).toBe(expectedMetadata);
        expect(start.envelope.authKeyB64).toBe(await keychain.authKeyB64());
        expect(start.envelope.manifest).toEqual([
            { name: 'big.bin', size: declaredSize, type: 'application/octet-stream' },
        ]);
        expect(start.envelope.expectedSize).toBe(declaredSize);
        expect(start.envelope.encrypted).toBe(false);
        expect(start.envelope.secretKeyB64).toBeUndefined();
        expect(start.envelope.timeLimit).toBe(86400);
        expect(start.envelope.downloadLimit).toBe(1);

        // The allocation request carried the declared size
        expect(uploadUrlBodies[0]).toMatchObject({ fileSize: declaredSize, encrypted: false });

        expect(result.id).toBe('file-id');
        expect(result.ownerToken).toBe('owner-token');

        // The legacy pipeline never ran: no part PUTs, no main-thread complete
        expect(FakeXhr.sends.length).toBe(0);
        expect(fetchCalls.filter((u) => u.includes('/upload/complete'))).toEqual([]);
    });

    it('falls through to the legacy pipeline when the kill switch disables the engine', async () => {
        localStorage.setItem('bolter:upload-engine', 'off');
        uploadUrlResponse = multipartUploadInfo(11, 10 * MB);

        const result = await uploadFiles(
            { files: [chunkedFile('big.bin', 110 * MB, MB)], encrypted: false },
            new Keychain(),
            new Canceller(),
        );

        expect(result.id).toBe('file-id');
        // Engine never engaged — no worker spawned, no probe, no start
        expect(FakeEngineWorker.instances.length).toBe(0);
        // The legacy multipart path did the work: part PUTs + main-thread complete
        expect(FakeXhr.sends.filter((s) => s.url.includes('s3.example.com/part')).length).toBe(11);
        expect(fetchCalls.some((u) => u.includes('/upload/complete'))).toBe(true);
    });

    it("re-labels the attempt 'legacy' when the backend declines multipart", async () => {
        // Declared input passes the engine gate, but the allocation comes
        // back non-multipart (realistic for compressible multi-file batches
        // whose DEFLATE zip shrinks under the backend threshold). The legacy
        // pipeline performs the upload — the attempt and success telemetry
        // must say so, with the fallback reason recorded [R16].
        const { trackUploadAttempt } = await import('@/lib/plausible');
        vi.mocked(trackUploadAttempt).mockClear();
        uploadUrlResponse = {
            useSignedUrl: true,
            multipart: false,
            id: 'file-id',
            owner: 'owner-token',
            url: 'https://s3.example.com/single',
        };

        const result = await uploadFiles(
            { files: [makeFile(1024, 150 * MB)], encrypted: false },
            new Keychain(),
            new Canceller(),
        );

        expect(result.id).toBe('file-id');
        // The legacy pipeline did the work (single PUT from the main thread).
        expect(FakeXhr.sends.length).toBe(1);
        // The unused engine allocation was released.
        expect(fetchCalls.some((u) => u.includes('/delete/file-id'))).toBe(true);

        const attempts = vi.mocked(trackUploadAttempt).mock.calls.map(([props]) => props);
        expect(attempts[0]).toMatchObject({ engine: 'worker' });
        expect(attempts[attempts.length - 1]).toMatchObject({
            engine: 'legacy',
            reason: 'backend-declined-multipart',
        });
        // Home stamps the success event from this — it must credit legacy.
        expect(currentUploadAttempt()?.engine).toBe('legacy');
    });

    it('bails to legacy before the speed test when the zipped size is under the threshold', async () => {
        // The delegation gate upstream sees the *declared input* size (160MB,
        // pre-zip). DEFLATE takes this batch well under the multipart
        // threshold, so the engine — which only runs multipart — must bail as
        // soon as the real size is known: before the 10s speed test and
        // before allocating an upload the backend would decline anyway.
        const { trackUploadAttempt } = await import('@/lib/plausible');
        vi.mocked(trackUploadAttempt).mockClear();
        uploadUrlResponse = {
            useSignedUrl: true,
            multipart: false,
            id: 'file-id',
            owner: 'owner-token',
            url: 'https://s3.example.com/single',
        };

        const zipProgress: number[] = [];
        const result = await uploadFiles(
            {
                files: [makeFile(1024, 80 * MB, 'a.bin'), makeFile(1024, 80 * MB, 'b.bin')],
                encrypted: false,
                onZipProgress: (p) => zipProgress.push(p),
            },
            new Keychain(),
            new Canceller(),
        );

        expect(result.id).toBe('file-id');
        // Neither preflight cost was paid by the abandoned engine attempt…
        expect(fetchCalls.filter((u) => u.includes('/upload/speedtest'))).toEqual([]);
        // …and the only allocation is the legacy pipeline's own, sized by the
        // zipped bytes, so nothing had to be released.
        expect(uploadUrlBodies.length).toBe(1);
        expect(Number(uploadUrlBodies[0].fileSize)).toBeLessThanOrEqual(100 * MB);
        expect(fetchCalls.some((u) => u.includes('/delete/'))).toBe(false);

        // The legacy pipeline reused the zip the engine attempt built rather
        // than running a second DEFLATE pass — a rebuild would rewind the zip
        // progress the user just watched reach 100%.
        expect(zipProgress[zipProgress.length - 1]).toBe(100);
        expect(zipProgress).toEqual([...zipProgress].sort((a, b) => a - b));

        // Legacy did the upload, and telemetry says so.
        expect(FakeXhr.sends.length).toBe(1);
        expect(fetchCalls.some((u) => u.includes('/upload/complete'))).toBe(true);
        const attempts = vi.mocked(trackUploadAttempt).mock.calls.map(([props]) => props);
        expect(attempts[0]).toMatchObject({ engine: 'worker' });
        expect(attempts[attempts.length - 1]).toMatchObject({
            engine: 'legacy',
            reason: 'below-threshold',
        });
        expect(currentUploadAttempt()?.engine).toBe('legacy');
    });

    it('uses the legacy pipeline for small uploads without probing', async () => {
        uploadUrlResponse = {
            useSignedUrl: true,
            multipart: false,
            id: 'file-id',
            owner: 'owner-token',
            url: 'https://s3.example.com/single',
        };

        const result = await uploadFiles(
            { files: [makeFile(1024)], encrypted: false },
            new Keychain(),
            new Canceller(),
        );

        expect(result.id).toBe('file-id');
        // Below the multipart threshold the engine is never even probed
        expect(FakeEngineWorker.instances.length).toBe(0);
        expect(FakeXhr.sends.length).toBe(1);
        expect(fetchCalls.some((u) => u.includes('/upload/complete'))).toBe(true);
    });

    it('routes resumeUpload to the engine when the id has an engine lease', async () => {
        const state = await openEngineState();
        await state.putLease({
            fileId: 'eng-1',
            uploadId: 'u-eng',
            uploadToken: 'tok-eng',
            ownerToken: 'own-eng',
            createdAt: Date.now(),
            engineVersion: 1,
        });
        FakeEngineWorker.onJob = (worker, message) => {
            if (message.type === 'resume') {
                worker.emit({ type: 'done', actualSize: 42 });
            }
        };

        const result = await resumeUpload(
            new File([new Uint8Array(4)], 'x.bin'),
            makeLegacyState('eng-1'),
        );

        expect(FakeEngineWorker.postedMessages()).toContainEqual({
            type: 'resume',
            fileId: 'eng-1',
        });
        expect(result.id).toBe('eng-1');
        expect(result.ownerToken).toBe('own-eng');
        // The legacy resume endpoint was never called from the main thread
        expect(fetchCalls.filter((u) => u.includes('/upload/multipart/'))).toEqual([]);
    });
});
