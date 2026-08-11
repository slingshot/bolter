import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The facade emits telemetry through @/lib/plausible; mock it so no analytics
// traffic can reach the fetch spies these tests assert against.
vi.mock('@/lib/plausible', () => ({
    newUploadAttemptId: () => 'ua_testattemptid',
    trackEngineEvent: vi.fn(),
    trackUploadAttempt: vi.fn(),
}));

import {
    EngineWorkerError,
    engineStartupMaintenance,
    probeEligibility,
    resetEligibilityCacheForTests,
    runEngineInWorker,
    setWorkerFactory,
} from '../client';
import type {
    ClientToWorker,
    EngineJob,
    EngineProbeRequest,
    EngineProbeResult,
    WorkerToClient,
} from '../protocol';
import { type CompletionEnvelope, type EngineLease, openEngineState } from '../state';

/**
 * Fake Worker installed via `setWorkerFactory` — implements the surface the
 * client facade touches (`postMessage`/`terminate`/`onmessage`/`onerror`) and
 * records everything for assertions.
 */
class FakeWorker {
    static instances: FakeWorker[] = [];

    onmessage: ((event: { data: WorkerToClient | EngineProbeResult }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    posted: (ClientToWorker | EngineProbeRequest)[] = [];
    terminated = false;

    constructor() {
        FakeWorker.instances.push(this);
    }

    postMessage(message: ClientToWorker | EngineProbeRequest): void {
        this.posted.push(message);
        if (message.type === 'probe') {
            queueMicrotask(() => this.onmessage?.({ data: { type: 'probe-result', ok: true } }));
        }
    }

    terminate(): void {
        this.terminated = true;
    }

    /** Deliver a worker→client message to the facade. */
    emit(message: WorkerToClient): void {
        this.onmessage?.({ data: message });
    }
}

function makeJob(): EngineJob {
    return {
        fileId: 'f1',
        uploadId: 'u1',
        uploadToken: 'tok',
        ownerToken: 'own',
        partUrls: ['https://bucket.example/part-1'],
        partSize: 4,
        encrypted: false,
        declaredTotalSize: 4,
        source: { kind: 'blob', blob: new Blob([new Uint8Array([1, 2, 3, 4])]) },
    };
}

function makeEnvelope(): CompletionEnvelope {
    return {
        fileId: 'f1',
        metadata: 'meta-b64',
        authKeyB64: 'auth-b64',
        manifest: [{ name: 'a.bin', size: 4, type: 'application/octet-stream' }],
        expectedSize: 4,
        encrypted: false,
        timeLimit: 86_400,
        downloadLimit: 10,
    };
}

function makeHooks() {
    const progress: [number, number][] = [];
    const stamps: (number | undefined)[] = [];
    let retries = 0;
    return {
        hooks: {
            onProgress: (sent: number, total: number, atMs?: number) => {
                progress.push([sent, total]);
                stamps.push(atMs);
            },
            onRetry: () => {
                retries++;
            },
        },
        progress,
        stamps,
        retries: () => retries,
    };
}

function makeCanceller() {
    let cb: (() => void) | undefined;
    return {
        canceller: {
            onCancel(f: () => void) {
                cb = f;
            },
        },
        cancel: () => cb?.(),
    };
}

describe('upload-engine client facade', () => {
    beforeEach(() => {
        FakeWorker.instances = [];
        localStorage.removeItem('bolter:upload-engine');
        resetEligibilityCacheForTests();
        // happy-dom has no Worker global; the probe's capability check only
        // needs it to exist — actual spawning goes through the factory.
        vi.stubGlobal('Worker', FakeWorker);
        setWorkerFactory(() => new FakeWorker() as unknown as Worker);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('probe honors the kill switch without spawning a worker', async () => {
        localStorage.setItem('bolter:upload-engine', 'off');
        setWorkerFactory(() => {
            throw new Error('must not spawn a worker when the kill switch is on');
        });
        await expect(probeEligibility()).resolves.toEqual({
            eligible: false,
            reason: 'kill-switch',
        });
    });

    it('probes worker/OPFS capability once per session', async () => {
        await expect(probeEligibility()).resolves.toEqual({ eligible: true });
        await expect(probeEligibility()).resolves.toEqual({ eligible: true });

        // Capability is a property of the browser, not of the upload.
        expect(FakeWorker.instances.length).toBe(1);
        expect(FakeWorker.instances[0].posted).toEqual([{ type: 'probe' }]);
        expect(FakeWorker.instances[0].terminated).toBe(true);
    });

    it('re-reads the kill switch on every probe, cached capability or not', async () => {
        await expect(probeEligibility()).resolves.toEqual({ eligible: true });

        // Flipped by hand mid-session to move a stuck user off the engine —
        // caching it would make the escape hatch require a reload.
        localStorage.setItem('bolter:upload-engine', 'off');
        await expect(probeEligibility()).resolves.toEqual({
            eligible: false,
            reason: 'kill-switch',
        });

        localStorage.removeItem('bolter:upload-engine');
        await expect(probeEligibility()).resolves.toEqual({ eligible: true });
        expect(FakeWorker.instances.length).toBe(1);
    });

    it('warms the capability cache at startup so the first upload never probes', async () => {
        await engineStartupMaintenance();

        // Startup did the probing, before any upload asked…
        expect(FakeWorker.instances.length).toBe(1);
        expect(FakeWorker.instances[0].posted).toEqual([{ type: 'probe' }]);

        // …so the first upload's probe reads that cache (in flight or
        // settled) instead of spawning a second worker.
        await expect(probeEligibility()).resolves.toEqual({ eligible: true });
        expect(FakeWorker.instances.length).toBe(1);
    });

    it('skips the startup warm-up while the kill switch is on', async () => {
        localStorage.setItem('bolter:upload-engine', 'off');

        await engineStartupMaintenance();

        // A disabled engine spawns nothing, warm-up included.
        expect(FakeWorker.instances.length).toBe(0);
    });

    it('caches an ineligible verdict so a broken worker is probed once', async () => {
        setWorkerFactory(() => {
            throw new Error('no workers here');
        });
        await expect(probeEligibility()).resolves.toEqual({
            eligible: false,
            reason: 'worker-spawn-failed',
        });

        // A failed probe is the expensive one (spawn failure, or a 5s
        // PROBE_TIMEOUT_MS hang) — it must not be repaid per upload.
        setWorkerFactory(() => new FakeWorker() as unknown as Worker);
        await expect(probeEligibility()).resolves.toEqual({
            eligible: false,
            reason: 'worker-spawn-failed',
        });
        expect(FakeWorker.instances.length).toBe(0);

        resetEligibilityCacheForTests();
        await expect(probeEligibility()).resolves.toEqual({ eligible: true });
        expect(FakeWorker.instances.length).toBe(1);
    });

    it('resolves with the done payload and forwards progress/retry to hooks', async () => {
        const { hooks, progress, retries } = makeHooks();
        const { canceller } = makeCanceller();
        const job = makeJob();
        const envelope = makeEnvelope();

        const run = runEngineInWorker(job, envelope, hooks, canceller);
        const worker = FakeWorker.instances[0];
        expect(worker.posted[0]).toEqual({ type: 'start', job, envelope });

        worker.emit({ type: 'progress', bytesSent: 2, totalBytes: 4 });
        worker.emit({ type: 'retry' });
        worker.emit({ type: 'done', actualSize: 4 });

        await expect(run).resolves.toEqual({ actualSize: 4 });
        expect(progress).toContainEqual([2, 4]);
        expect(retries()).toBe(1);
    });

    it("relays the worker's own timestamp with progress", async () => {
        const { hooks, progress, stamps } = makeHooks();
        const { canceller } = makeCanceller();

        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        const worker = FakeWorker.instances[0];

        // Stamped by the worker when it observed the bytes — the reporter
        // times throughput by this, not by when the message was delivered.
        worker.emit({ type: 'progress', bytesSent: 2, totalBytes: 4, atMs: 1_700_000_000_123 });
        worker.emit({ type: 'done', actualSize: 4 });

        await expect(run).resolves.toEqual({ actualSize: 4 });
        expect(progress).toEqual([[2, 4]]);
        expect(stamps).toEqual([1_700_000_000_123]);
    });

    it('rejects when the worker reports a non-retryable error', async () => {
        const { hooks } = makeHooks();
        const { canceller } = makeCanceller();

        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        const worker = FakeWorker.instances[0];
        worker.emit({
            type: 'error',
            message: 'part sequence invalid: no parts',
            retryable: false,
        });

        await expect(run).rejects.toThrow('part sequence invalid: no parts');
    });

    it('failure telemetry detail carries the pipeline stage', async () => {
        const { trackEngineEvent } = await import('@/lib/plausible');
        vi.mocked(trackEngineEvent).mockClear();
        const { hooks } = makeHooks();
        const { canceller } = makeCanceller();

        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        const worker = FakeWorker.instances[0];
        worker.emit({
            type: 'error',
            message: 'OPFS quota exhausted while staging part 2',
            retryable: true,
            stage: 'stager-quota',
        });

        await expect(run).rejects.toThrow(/quota/);
        expect(vi.mocked(trackEngineEvent)).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'failure', detail: 'stager-quota:retryable' }),
        );
    });

    it('adopts the worker-side stack, name and stage so failures group apart', async () => {
        const { hooks } = makeHooks();
        const { canceller } = makeCanceller();

        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        const worker = FakeWorker.instances[0];
        // Every worker failure is rethrown from the same three facade frames,
        // and Sentry groups on the stack — so without the worker's own stack
        // an OPFS rename fault and an HTTP 400 land in one issue.
        worker.emit({
            type: 'error',
            message: 'Not enough arguments',
            retryable: false,
            stage: 'staging',
            name: 'TypeError',
            stack: 'TypeError: Not enough arguments\n    at commitByRename (part-store.ts:430:25)',
        });

        const err = (await run.catch((e: unknown) => e)) as EngineWorkerError;
        expect(err).toBeInstanceOf(EngineWorkerError);
        expect(err.stage).toBe('staging');
        expect(err.workerName).toBe('TypeError');
        expect(err.stack).toContain('commitByRename');
    });

    it('keeps its own stack when the worker reports none', async () => {
        const { hooks } = makeHooks();
        const { canceller } = makeCanceller();

        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        FakeWorker.instances[0].emit({
            type: 'error',
            message: 'part sequence invalid: no parts',
            retryable: false,
        });

        const err = (await run.catch((e: unknown) => e)) as EngineWorkerError;
        expect(err.stack).toContain('EngineWorkerError');
        expect(err.workerName).toBeUndefined();
        expect(err.stage).toBeUndefined();
    });

    it('relays online/offline window events as connectivity messages', async () => {
        const { hooks } = makeHooks();
        const { canceller } = makeCanceller();

        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        const worker = FakeWorker.instances[0];

        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('online'));
        expect(worker.posted).toContainEqual({ type: 'connectivity', online: false });
        expect(worker.posted).toContainEqual({ type: 'connectivity', online: true });

        worker.emit({ type: 'done', actualSize: 4 });
        await run;
    });

    it('cancel with a worker ack rejects with a cancellation error, no terminate', async () => {
        const { hooks } = makeHooks();
        const { canceller, cancel } = makeCanceller();

        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        const worker = FakeWorker.instances[0];

        cancel();
        expect(worker.posted).toContainEqual({ type: 'cancel' });
        worker.emit({ type: 'cancelled' });

        await expect(run).rejects.toThrow('Upload cancelled');
        expect(worker.terminated).toBe(false);
    });

    it('escalates an unacked cancel: terminate + main-thread abort after 10s', async () => {
        vi.useFakeTimers();
        const fetchSpy = vi.fn().mockResolvedValue(new Response('{"success":true}'));
        vi.stubGlobal('fetch', fetchSpy);
        const { hooks } = makeHooks();
        const { canceller, cancel } = makeCanceller();

        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        const rejection = expect(run).rejects.toThrow('Upload cancelled');
        const worker = FakeWorker.instances[0];

        cancel();
        expect(worker.posted).toContainEqual({ type: 'cancel' });
        expect(worker.terminated).toBe(false);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(worker.terminated).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(String(url)).toContain('/upload/abort/f1');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
            uploadId: 'u1',
            uploadToken: 'tok',
        });
        await rejection;
    });

    it('escalated cancel clears engine state so no phantom resume survives', async () => {
        // A cancelled upload whose worker never acks (suspended/crashed) must
        // not leave the lease + envelope + parts behind: they would surface a
        // "Finish upload" card for an upload the user explicitly cancelled,
        // and the surviving lease would shield the staged ciphertext (and
        // secretKeyB64) from GC indefinitely.
        const fetchSpy = vi.fn().mockResolvedValue(new Response('{"success":true}'));
        vi.stubGlobal('fetch', fetchSpy);
        // Seed with real timers — fake-indexeddb schedules its transactions
        // through them; fake timers go on only around the escalation window.
        const state = await openEngineState();
        await state.putLease({
            fileId: 'f1',
            uploadId: 'u1',
            uploadToken: 'tok',
            ownerToken: 'own',
            createdAt: Date.now(),
            engineVersion: 1,
        });
        await state.putEnvelope({
            fileId: 'f1',
            metadata: 'meta-b64',
            authKeyB64: 'auth-b64',
            manifest: [{ name: 'a.bin', size: 4, type: 'application/octet-stream' }],
            expectedSize: 4,
            encrypted: true,
            secretKeyB64: 'secret-b64',
            timeLimit: 86_400,
            downloadLimit: 10,
        });
        await state.putPart({
            fileId: 'f1',
            partNumber: 1,
            size: 4,
            staged: true,
            uploaded: false,
        });
        const { hooks } = makeHooks();
        const { canceller, cancel } = makeCanceller();

        // Fake only setTimeout (the escalation window) — fake-indexeddb needs
        // its own scheduling primitives real for the cleanup to run.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const run = runEngineInWorker(makeJob(), makeEnvelope(), hooks, canceller);
        const rejection = expect(run).rejects.toThrow('Upload cancelled');
        cancel();
        await vi.advanceTimersByTimeAsync(10_000);
        await rejection;

        // The abort ran first, then the local teardown — poll with real
        // timers since the cleanup floats behind the rejection.
        vi.useRealTimers();
        await expect
            .poll(async () => (await state.getLease('f1')) === undefined, { timeout: 2000 })
            .toBe(true);
        expect(await state.getEnvelope('f1')).toBeUndefined();
        expect(await state.getParts('f1')).toEqual([]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0][0])).toContain('/upload/abort/f1');
    });
});

function deleteDatabase(name: string): Promise<void> {
    return new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function makeLease(fileId: string, createdAt: number): EngineLease {
    return {
        fileId,
        uploadId: `mp-${fileId}`,
        uploadToken: `tok-${fileId}`,
        ownerToken: `own-${fileId}`,
        createdAt,
        engineVersion: 1,
    };
}

function makeStoredEnvelope(fileId: string, timeLimit: number): CompletionEnvelope {
    return {
        fileId,
        metadata: 'meta-b64',
        authKeyB64: 'auth-b64',
        manifest: [{ name: 'a.bin', size: 4, type: 'application/octet-stream' }],
        expectedSize: 4,
        encrypted: true,
        secretKeyB64: 'secret-b64',
        timeLimit,
        downloadLimit: 1,
    };
}

describe('engineStartupMaintenance lease expiry', () => {
    beforeEach(async () => {
        await deleteDatabase('bolter-upload-engine');
        localStorage.removeItem('bolter:upload-engine');
        setWorkerFactory(() => new FakeWorker() as unknown as Worker);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('discards a lease older than its server metadata TTL', async () => {
        // The multipart died server-side at the TTL; without expiry the lease
        // retained secretKeyB64 + staged ciphertext in origin storage forever.
        const fetchSpy = vi.fn().mockResolvedValue(new Response('{"success":true}'));
        vi.stubGlobal('fetch', fetchSpy);
        const state = await openEngineState();
        await state.putLease(makeLease('exp1', Date.now() - 2 * DAY_MS));
        await state.putEnvelope(makeStoredEnvelope('exp1', 86_400)); // 1-day TTL
        await state.putPart({
            fileId: 'exp1',
            partNumber: 1,
            size: 4,
            staged: true,
            uploaded: false,
        });

        const candidates = await engineStartupMaintenance();

        expect(candidates.find((c) => c.fileId === 'exp1')).toBeUndefined();
        expect(await state.getLease('exp1')).toBeUndefined();
        expect(await state.getEnvelope('exp1')).toBeUndefined();
        expect(await state.getParts('exp1')).toEqual([]);
        // The discard attempted the authenticated server-side abort too.
        expect(
            fetchSpy.mock.calls.some(([url]) => String(url).includes('/upload/abort/exp1')),
        ).toBe(true);
    });

    it('discards an envelope-less lease after the 7-day cap', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"success":true}')));
        const state = await openEngineState();
        await state.putLease(makeLease('exp2', Date.now() - 8 * DAY_MS));

        await engineStartupMaintenance();

        expect(await state.getLease('exp2')).toBeUndefined();
    });

    it('keeps fresh leases and still offers their resume', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"success":true}')));
        const state = await openEngineState();
        await state.putLease(makeLease('fresh1', Date.now() - 60_000));
        await state.putEnvelope(makeStoredEnvelope('fresh1', 86_400));

        const candidates = await engineStartupMaintenance();

        expect(await state.getLease('fresh1')).toBeDefined();
        expect(candidates.find((c) => c.fileId === 'fresh1')).toMatchObject({
            action: 'need-source-single',
        });
    });
});
