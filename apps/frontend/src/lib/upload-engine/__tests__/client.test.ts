import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The facade emits telemetry through @/lib/plausible; mock it so no analytics
// traffic can reach the fetch spies these tests assert against.
vi.mock('@/lib/plausible', () => ({
    newUploadAttemptId: () => 'ua_testattemptid',
    trackEngineEvent: vi.fn(),
    trackUploadAttempt: vi.fn(),
}));

import { probeEligibility, runEngineInWorker, setWorkerFactory } from '../client';
import type { ClientToWorker, EngineJob, WorkerToClient } from '../protocol';
import { type CompletionEnvelope, openEngineState } from '../state';

/**
 * Fake Worker installed via `setWorkerFactory` — implements the surface the
 * client facade touches (`postMessage`/`terminate`/`onmessage`/`onerror`) and
 * records everything for assertions.
 */
class FakeWorker {
    static instances: FakeWorker[] = [];

    onmessage: ((event: { data: WorkerToClient }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    posted: ClientToWorker[] = [];
    terminated = false;

    constructor() {
        FakeWorker.instances.push(this);
    }

    postMessage(message: ClientToWorker): void {
        this.posted.push(message);
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
        maxConcurrent: 1,
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
    let retries = 0;
    return {
        hooks: {
            onProgress: (sent: number, total: number) => {
                progress.push([sent, total]);
            },
            onRetry: () => {
                retries++;
            },
        },
        progress,
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
