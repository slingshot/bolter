import { createConcurrencyController } from '@bolter/protocol/concurrency';
import { describe, expect, it, vi } from 'vitest';
import { MemoryPartStore, type PartStore } from '../part-store';
import type {
    CompletionEnvelope,
    EngineLease,
    EnginePartRecord,
    EngineStateStore,
    ProducerCheckpoint,
} from '../state';
import { runUploaders, type UploaderOpts } from '../uploader';

function makeData(size: number): Uint8Array {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = i % 256;
    }
    return data;
}

// biome-ignore lint/suspicious/useAwait: async generator builds the AsyncIterable the PartStore contract requires
async function* chunks(...arrays: Uint8Array[]) {
    for (const a of arrays) {
        yield a;
    }
}

async function stage(store: PartStore, partNumber: number, bytes: Uint8Array): Promise<void> {
    await store.stagePart(partNumber, chunks(bytes));
}

/** Pull queue over a fixed part list: null once drained. */
function makeQueue(parts: { partNumber: number; size: number }[]) {
    const queue = [...parts];
    return () => Promise.resolve(queue.shift() ?? null);
}

/**
 * Parts `1..n` staged with matching pre-signed URLs — the fixture the
 * pool-sizing tests share, since every attempt re-reads the store.
 */
async function pool(
    n: number,
    size = 4,
): Promise<{
    store: MemoryPartStore;
    urls: string[];
    parts: { partNumber: number; size: number }[];
    queue: () => Promise<{ partNumber: number; size: number } | null>;
}> {
    const store = new MemoryPartStore();
    const parts: { partNumber: number; size: number }[] = [];
    for (let partNumber = 1; partNumber <= n; partNumber++) {
        await stage(store, partNumber, makeData(size));
        parts.push({ partNumber, size });
    }
    return {
        store,
        parts,
        urls: parts.map((p) => `https://s3.example.com/part${p.partNumber}`),
        queue: makeQueue(parts),
    };
}

/**
 * Pull queue that parks for `delayMs` of wall clock before yielding. Slow
 * staging must read as the pool idling, not as the pool being the bottleneck.
 */
function slowQueue(
    parts: { partNumber: number; size: number }[],
    clock: ReturnType<typeof fakeClock>,
    delayMs: number,
): () => Promise<{ partNumber: number; size: number } | null> {
    const queue = [...parts];
    return () => {
        clock.advance(delayMs);
        return Promise.resolve(queue.shift() ?? null);
    };
}

/** Let pending promise chains settle (real zero-delay timers). */
async function flush(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

/**
 * Deterministic wall clock + timer queue. `advance` moves the clock and runs
 * every callback that has come due, earliest first — a callback scheduled at
 * 1s that only runs after a 6s jump sees the full 6s wall-clock delta, exactly
 * like a throttled worker timer.
 */
function fakeClock() {
    let t = 0;
    const scheduled: { at: number; fn: () => void }[] = [];
    return {
        now: () => t,
        setTimeoutFn: (fn: () => void, ms: number): unknown => {
            scheduled.push({ at: t + ms, fn });
            return 0;
        },
        advance(ms: number) {
            t += ms;
            while (true) {
                let idx = -1;
                for (let i = 0; i < scheduled.length; i++) {
                    if (
                        scheduled[i].at <= t &&
                        (idx === -1 || scheduled[i].at < scheduled[idx].at)
                    ) {
                        idx = i;
                    }
                }
                if (idx === -1) {
                    return;
                }
                const [entry] = scheduled.splice(idx, 1);
                entry.fn();
            }
        },
    };
}

/** Fake `EngineStateStore` backed by Maps, recording puts into `log`. */
function fakeState(log: string[] = []) {
    const leases = new Map<string, EngineLease>();
    const envelopes = new Map<string, CompletionEnvelope>();
    const checkpoints = new Map<string, ProducerCheckpoint>();
    const parts = new Map<string, EnginePartRecord>();
    const partPuts: EnginePartRecord[] = [];
    const state: EngineStateStore = {
        putLease(l) {
            leases.set(l.fileId, l);
            return Promise.resolve();
        },
        getLease(fileId) {
            return Promise.resolve(leases.get(fileId));
        },
        putEnvelope(e) {
            envelopes.set(e.fileId, e);
            return Promise.resolve();
        },
        getEnvelope(fileId) {
            return Promise.resolve(envelopes.get(fileId));
        },
        putCheckpoint(c) {
            checkpoints.set(c.fileId, c);
            return Promise.resolve();
        },
        getCheckpoint(fileId) {
            return Promise.resolve(checkpoints.get(fileId));
        },
        putPart(p) {
            log.push(`putPart:${p.partNumber}:${p.uploaded ? 'uploaded' : 'staged'}`);
            partPuts.push({ ...p });
            parts.set(`${p.fileId}:${p.partNumber}`, p);
            return Promise.resolve();
        },
        putPartAndCheckpoint(p, c) {
            log.push(`putPart:${p.partNumber}:${p.uploaded ? 'uploaded' : 'staged'}`);
            partPuts.push({ ...p });
            parts.set(`${p.fileId}:${p.partNumber}`, p);
            checkpoints.set(c.fileId, c);
            return Promise.resolve();
        },
        getParts(fileId) {
            return Promise.resolve(
                [...parts.values()]
                    .filter((p) => p.fileId === fileId)
                    .sort((a, b) => a.partNumber - b.partNumber),
            );
        },
        listLeases() {
            return Promise.resolve([...leases.values()]);
        },
        clearUpload(fileId) {
            leases.delete(fileId);
            envelopes.delete(fileId);
            checkpoints.delete(fileId);
            for (const key of [...parts.keys()]) {
                if (key.startsWith(`${fileId}:`)) {
                    parts.delete(key);
                }
            }
            return Promise.resolve();
        },
    };
    return { state, partPuts, log };
}

/** `PartStore` wrapper recording read/delete order into `log`. */
class RecordingPartStore implements PartStore {
    constructor(
        private readonly inner: PartStore,
        private readonly log: string[],
    ) {}

    stagePart(partNumber: number, chunks: AsyncIterable<Uint8Array>): Promise<{ size: number }> {
        return this.inner.stagePart(partNumber, chunks);
    }

    readPart(partNumber: number): Promise<Blob> {
        this.log.push(`readPart:${partNumber}`);
        return this.inner.readPart(partNumber);
    }

    deletePart(partNumber: number): Promise<void> {
        this.log.push(`deletePart:${partNumber}`);
        return this.inner.deletePart(partNumber);
    }

    listParts(): Promise<{ partNumber: number; size: number }[]> {
        return this.inner.listParts();
    }

    destroy(): Promise<void> {
        return this.inner.destroy();
    }
}

/**
 * Base options: wall clock is real but timers never fire, so nothing depends
 * on cadence unless a test injects the fake clock explicitly.
 */
function baseOpts(over: Partial<UploaderOpts>): UploaderOpts {
    return {
        urls: [
            'https://s3.example.com/part1',
            'https://s3.example.com/part2',
            'https://s3.example.com/part3',
        ],
        maxConcurrent: 2,
        store: new MemoryPartStore(),
        state: fakeState().state,
        fileId: 'up_test',
        uploadPart: () => Promise.reject(new Error('uploadPart not faked')),
        refreshUrls: () => Promise.reject(new Error('refreshUrls should not be called')),
        now: () => Date.now(),
        isOnline: () => true,
        retryDelayMs: () => 0,
        onProgress: () => undefined,
        onRetry: () => undefined,
        signal: new AbortController().signal,
        setTimeoutFn: () => 0,
        ...over,
    };
}

describe('runUploaders', () => {
    it('uploads all parts, recording uploaded+etag before deleting staged bytes', async () => {
        const log: string[] = [];
        const store = new RecordingPartStore(new MemoryPartStore(), log);
        const { state, partPuts } = fakeState(log);
        await stage(store, 1, makeData(4));
        await stage(store, 2, makeData(4));
        await stage(store, 3, makeData(2));

        const progress: number[] = [];
        const uploadPart: UploaderOpts['uploadPart'] = (url) =>
            Promise.resolve({ etag: `etag-${url.slice(-1)}` });

        const etags = await runUploaders(
            makeQueue([
                { partNumber: 1, size: 4 },
                { partNumber: 2, size: 4 },
                { partNumber: 3, size: 2 },
            ]),
            baseOpts({
                store,
                state,
                uploadPart,
                maxConcurrent: 2,
                onProgress: (total) => {
                    progress.push(total);
                },
            }),
        );

        expect(etags).toEqual(
            new Map([
                [1, 'etag-1'],
                [2, 'etag-2'],
                [3, 'etag-3'],
            ]),
        );
        expect(await store.listParts()).toEqual([]);
        expect(partPuts).toEqual([
            {
                fileId: 'up_test',
                partNumber: 1,
                size: 4,
                staged: true,
                uploaded: true,
                etag: 'etag-1',
            },
            {
                fileId: 'up_test',
                partNumber: 2,
                size: 4,
                staged: true,
                uploaded: true,
                etag: 'etag-2',
            },
            {
                fileId: 'up_test',
                partNumber: 3,
                size: 2,
                staged: true,
                uploaded: true,
                etag: 'etag-3',
            },
        ]);
        // The uploaded+etag record commits before the staged bytes are released [R11].
        for (const partNumber of [1, 2, 3]) {
            const put = log.indexOf(`putPart:${partNumber}:uploaded`);
            const del = log.indexOf(`deletePart:${partNumber}`);
            expect(put).toBeGreaterThanOrEqual(0);
            expect(del).toBeGreaterThan(put);
        }
        expect(progress[progress.length - 1]).toBe(10);
    });

    it('starts the staged-part deletion only after the uploaded+ETag record commits [R11]', async () => {
        const log: string[] = [];
        const store = new RecordingPartStore(new MemoryPartStore(), log);
        await stage(store, 1, makeData(4));
        const { state } = fakeState(log);
        let commitRecord: (() => void) | undefined;
        const gatedState: EngineStateStore = {
            ...state,
            putPart(p) {
                log.push(`putPart:${p.partNumber}:${p.uploaded ? 'uploaded' : 'staged'}`);
                return new Promise<void>((resolve) => {
                    commitRecord = resolve;
                });
            },
        };

        const run = runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({
                store,
                state: gatedState,
                uploadPart: () => Promise.resolve({ etag: 'etag-1' }),
                maxConcurrent: 1,
            }),
        );
        run.catch(() => undefined);
        await flush();

        // The PUT is done but the record has not committed: the staged bytes
        // are the only copy of this part, so nothing may have touched them.
        expect(log).toContain('putPart:1:uploaded');
        expect(log).not.toContain('deletePart:1');
        expect(await store.listParts()).toEqual([{ partNumber: 1, size: 4 }]);

        commitRecord?.();
        expect(await run).toEqual(new Map([[1, 'etag-1']]));
        await flush();
        expect(log.indexOf('deletePart:1')).toBeGreaterThan(log.indexOf('putPart:1:uploaded'));
    });

    it('takes the next part without waiting for the previous deletion to finish', async () => {
        const log: string[] = [];
        const inner = new MemoryPartStore();
        await stage(inner, 1, makeData(4));
        await stage(inner, 2, makeData(4));
        let finishFirstDelete: (() => void) | undefined;
        const store: PartStore = {
            stagePart: (partNumber, chunks) => inner.stagePart(partNumber, chunks),
            readPart: (partNumber) => {
                log.push(`readPart:${partNumber}`);
                return inner.readPart(partNumber);
            },
            deletePart: (partNumber) => {
                log.push(`deletePart:${partNumber}`);
                if (partNumber !== 1) {
                    return inner.deletePart(partNumber);
                }
                // A slow OPFS delete: the run must not be behind it.
                return new Promise<void>((resolve) => {
                    finishFirstDelete = () => resolve(inner.deletePart(1));
                });
            },
            listParts: () => inner.listParts(),
            destroy: () => inner.destroy(),
        };
        const { state } = fakeState(log);

        const etags = await runUploaders(
            makeQueue([
                { partNumber: 1, size: 4 },
                { partNumber: 2, size: 4 },
            ]),
            baseOpts({
                store,
                state,
                uploadPart: (url) => Promise.resolve({ etag: `etag-${url.slice(-1)}` }),
                maxConcurrent: 1,
            }),
        );

        expect(etags).toEqual(
            new Map([
                [1, 'etag-1'],
                [2, 'etag-2'],
            ]),
        );
        // Part 2 was read, uploaded and recorded while part 1's deletion was
        // still in flight — the deletion is off the critical path entirely.
        expect(finishFirstDelete).toBeDefined();
        expect(log.indexOf('deletePart:1')).toBeLessThan(log.indexOf('readPart:2'));
        finishFirstDelete?.();
    });

    it.each([
        ['rejects', () => Promise.reject(new Error('OPFS removeEntry failed'))],
        [
            'throws synchronously',
            () => {
                throw new Error('OPFS handle is closed');
            },
        ],
    ])('survives a staged-part deletion that %s', async (_label, deletePart) => {
        const inner = new MemoryPartStore();
        await stage(inner, 1, makeData(4));
        let uploads = 0;
        const store: PartStore = {
            stagePart: (partNumber, chunks) => inner.stagePart(partNumber, chunks),
            readPart: (partNumber) => inner.readPart(partNumber),
            deletePart: deletePart as PartStore['deletePart'],
            listParts: () => inner.listParts(),
            destroy: () => inner.destroy(),
        };
        const { state, partPuts } = fakeState();

        const etags = await runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({
                store,
                state,
                uploadPart: () => {
                    uploads += 1;
                    return Promise.resolve({ etag: 'etag-1' });
                },
                maxConcurrent: 1,
            }),
        );
        await flush();

        // The ETag is what completion needs, and the part is not re-sent: the
        // orphaned bytes are reaped by the completion/cancel `destroy()` and
        // by startup GC.
        expect(etags).toEqual(new Map([[1, 'etag-1']]));
        expect(uploads).toBe(1);
        expect(partPuts).toEqual([
            {
                fileId: 'up_test',
                partNumber: 1,
                size: 4,
                staged: true,
                uploaded: true,
                etag: 'etag-1',
            },
        ]);
    });

    it('re-reads the staged part so retries are byte-identical', async () => {
        const clock = fakeClock();
        const log: string[] = [];
        const store = new RecordingPartStore(new MemoryPartStore(), log);
        const { state } = fakeState(log);
        await stage(store, 1, makeData(6));

        const bodies: Uint8Array[] = [];
        let retries = 0;
        const uploadPart: UploaderOpts['uploadPart'] = async (_url, body) => {
            bodies.push(new Uint8Array(await body.arrayBuffer()));
            if (bodies.length === 1) {
                throw new Error('network error');
            }
            return { etag: 'etag-1' };
        };

        const run = runUploaders(
            makeQueue([{ partNumber: 1, size: 6 }]),
            baseOpts({
                store,
                state,
                uploadPart,
                maxConcurrent: 1,
                retryDelayMs: () => 50,
                onRetry: () => {
                    retries += 1;
                },
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
            }),
        );
        await flush();
        expect(retries).toBe(1);
        clock.advance(50); // retry backoff elapses
        await flush();

        const etags = await run;
        expect(etags).toEqual(new Map([[1, 'etag-1']]));
        expect(log.filter((e) => e === 'readPart:1')).toHaveLength(2);
        expect(bodies).toHaveLength(2);
        expect(bodies[0]).toEqual(makeData(6));
        expect(bodies[1]).toEqual(bodies[0]);
    });

    it('aborts a stalled attempt on wall-clock delta and retries it', async () => {
        const clock = fakeClock();
        const store = new MemoryPartStore();
        const { state } = fakeState();
        await stage(store, 1, makeData(4));

        let retries = 0;
        const attempts: { signal: AbortSignal }[] = [];
        const uploadPart: UploaderOpts['uploadPart'] = (_url, _body, hooks) => {
            attempts.push({ signal: hooks.signal });
            if (attempts.length === 1) {
                // Reports progress once, then hangs until aborted.
                return new Promise((_resolve, reject) => {
                    hooks.onProgress(1);
                    hooks.signal.addEventListener('abort', () =>
                        reject(new Error('transport aborted')),
                    );
                });
            }
            return Promise.resolve({ etag: 'etag-1' });
        };

        const run = runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({
                store,
                state,
                uploadPart,
                maxConcurrent: 1,
                stallMs: 5000,
                retryDelayMs: () => 100,
                onRetry: () => {
                    retries += 1;
                },
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
            }),
        );
        await flush();
        expect(attempts).toHaveLength(1);

        // The stall check was scheduled at +1s but only fires after a 6s jump —
        // it must measure the wall-clock delta, not trust its own cadence.
        clock.advance(6001);
        await flush();
        expect(attempts[0].signal.aborted).toBe(true);
        expect(retries).toBe(1);

        clock.advance(100); // retry backoff
        await flush();
        const etags = await run;
        expect(attempts).toHaveLength(2);
        expect(etags).toEqual(new Map([[1, 'etag-1']]));
    });

    it('gates retries on connectivity, polling isOnline at 1s wall-clock intervals', async () => {
        const clock = fakeClock();
        const store = new MemoryPartStore();
        const { state } = fakeState();
        await stage(store, 1, makeData(4));

        let online = true;
        let calls = 0;
        const uploadPart: UploaderOpts['uploadPart'] = () => {
            calls += 1;
            if (calls === 1) {
                online = false;
                return Promise.reject(new Error('network error'));
            }
            return Promise.resolve({ etag: 'etag-1' });
        };

        const run = runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({
                store,
                state,
                uploadPart,
                maxConcurrent: 1,
                retryDelayMs: () => 0,
                isOnline: () => online,
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
            }),
        );
        await flush();
        expect(calls).toBe(1);
        clock.advance(0); // zero-delay retry backoff elapses
        await flush();

        // Still offline: connectivity polls fire but no retry is attempted.
        for (let i = 0; i < 3; i++) {
            clock.advance(1000);
            await flush();
        }
        expect(calls).toBe(1);

        online = true;
        clock.advance(1000);
        await flush();
        expect(calls).toBe(2);
        expect(await run).toEqual(new Map([[1, 'etag-1']]));
    });

    it('rejects the run on a non-retryable error and aborts in-flight workers', async () => {
        const store = new MemoryPartStore();
        const { state, partPuts } = fakeState();
        await stage(store, 1, makeData(4));
        await stage(store, 2, makeData(4));

        let part1Signal: AbortSignal | undefined;
        const uploadPart: UploaderOpts['uploadPart'] = (url, _body, hooks) => {
            if (url.endsWith('part1')) {
                part1Signal = hooks.signal;
                return new Promise((_resolve, reject) => {
                    hooks.signal.addEventListener('abort', () =>
                        reject(new Error('transport aborted')),
                    );
                });
            }
            return Promise.reject(new Error('HTTP 400 (Bad Request)'));
        };

        await expect(
            runUploaders(
                makeQueue([
                    { partNumber: 1, size: 4 },
                    { partNumber: 2, size: 4 },
                ]),
                baseOpts({ store, state, uploadPart, maxConcurrent: 2 }),
            ),
        ).rejects.toThrow('HTTP 400');

        expect(part1Signal?.aborted).toBe(true);
        expect(partPuts.filter((p) => p.uploaded)).toEqual([]);
        // Nothing was deleted: both staged parts survive for resume.
        expect((await store.listParts()).map((p) => p.partNumber)).toEqual([1, 2]);
    });

    it('gives up after maxAttemptsPerPart retryable failures', async () => {
        const clock = fakeClock();
        const store = new MemoryPartStore();
        const { state } = fakeState();
        await stage(store, 1, makeData(4));

        let calls = 0;
        let retries = 0;
        const uploadPart: UploaderOpts['uploadPart'] = () => {
            calls += 1;
            return Promise.reject(new Error('network error'));
        };

        const run = runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({
                store,
                state,
                uploadPart,
                maxConcurrent: 1,
                maxAttemptsPerPart: 2,
                retryDelayMs: () => 10,
                onRetry: () => {
                    retries += 1;
                },
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
            }),
        );
        run.catch(() => undefined); // assert below; avoid unhandled rejection between flushes
        await flush();
        clock.advance(10);
        await flush();

        await expect(run).rejects.toThrow('network error');
        expect(calls).toBe(2);
        expect(retries).toBe(1);
    });

    it('infers offline from consecutive immediate failures instead of dying (spec R14)', async () => {
        // The relayed online flag is stale-true (the offline event never
        // reached the worker). Each attempt fails instantly with "HTTP 0";
        // without inference the run would burn maxAttemptsPerPart and reject.
        const clock = fakeClock();
        const store = new MemoryPartStore();
        const { state } = fakeState();
        await stage(store, 1, makeData(4));

        let calls = 0;
        let networkDead = true;
        const uploadPart: UploaderOpts['uploadPart'] = () => {
            calls += 1;
            if (networkDead) {
                return Promise.reject(new Error('HTTP 0'));
            }
            return Promise.resolve({ etag: 'etag-1' });
        };

        const run = runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({
                store,
                state,
                uploadPart,
                maxConcurrent: 1,
                maxAttemptsPerPart: 4,
                retryDelayMs: () => 10,
                isOnline: () => true, // missed relay — flag stays optimistic
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
            }),
        );
        run.catch(() => undefined);

        // Ride far past what used to be the whole attempt budget…
        for (let i = 0; i < 12; i++) {
            clock.advance(10);
            await flush();
        }
        // …the run is still alive, probing on the backoff interval.
        expect(calls).toBeGreaterThan(4);

        networkDead = false;
        clock.advance(10);
        await flush();
        expect(await run).toEqual(new Map([[1, 'etag-1']]));
    });

    it('a fast server error never feeds offline inference', async () => {
        // HTTP 429 answers arrive instantly too, but a responding server is
        // not a dead link — the attempt budget must still apply.
        const clock = fakeClock();
        const store = new MemoryPartStore();
        const { state } = fakeState();
        await stage(store, 1, makeData(4));

        let calls = 0;
        const uploadPart: UploaderOpts['uploadPart'] = () => {
            calls += 1;
            return Promise.reject(new Error('HTTP 429 (Too Many Requests)'));
        };

        const run = runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({
                store,
                state,
                uploadPart,
                maxConcurrent: 1,
                maxAttemptsPerPart: 4,
                offlineInferenceThreshold: 3,
                retryDelayMs: () => 10,
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
            }),
        );
        run.catch(() => undefined);
        for (let i = 0; i < 12; i++) {
            clock.advance(10);
            await flush();
        }

        await expect(run).rejects.toThrow('HTTP 429');
        expect(calls).toBe(4);
    });

    it('refreshes expired URLs once per part and retries with the fresh URL', async () => {
        const store = new MemoryPartStore();
        const { state } = fakeState();
        await stage(store, 1, makeData(4));

        let refreshes = 0;
        const seen: string[] = [];
        const uploadPart: UploaderOpts['uploadPart'] = (url) => {
            seen.push(url);
            if (seen.length === 1) {
                return Promise.reject(new Error('HTTP 403 (Forbidden)'));
            }
            return Promise.resolve({ etag: 'etag-1' });
        };

        const etags = await runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({
                store,
                state,
                uploadPart,
                maxConcurrent: 1,
                urls: ['https://s3.example.com/stale1'],
                refreshUrls: () => {
                    refreshes += 1;
                    return Promise.resolve(['https://s3.example.com/fresh1']);
                },
            }),
        );

        expect(refreshes).toBe(1);
        expect(seen).toEqual(['https://s3.example.com/stale1', 'https://s3.example.com/fresh1']);
        expect(etags).toEqual(new Map([[1, 'etag-1']]));
    });

    it('rejects on external cancel and aborts the in-flight attempt', async () => {
        const store = new MemoryPartStore();
        const { state } = fakeState();
        await stage(store, 1, makeData(4));

        let attemptSignal: AbortSignal | undefined;
        const uploadPart: UploaderOpts['uploadPart'] = (_url, _body, hooks) => {
            attemptSignal = hooks.signal;
            return new Promise((_resolve, reject) => {
                hooks.signal.addEventListener('abort', () =>
                    reject(new Error('transport aborted')),
                );
            });
        };

        const cancel = new AbortController();
        const run = runUploaders(
            makeQueue([{ partNumber: 1, size: 4 }]),
            baseOpts({ store, state, uploadPart, maxConcurrent: 1, signal: cancel.signal }),
        );
        run.catch(() => undefined);
        await flush();
        expect(attemptSignal?.aborted).toBe(false);

        cancel.abort();
        await expect(run).rejects.toThrow('Upload cancelled');
        expect(attemptSignal?.aborted).toBe(true);
        expect((await store.listParts()).map((p) => p.partNumber)).toEqual([1]);
    });

    it('coalesces byte progress to a wall-clock cadence, stamped with the producer clock', async () => {
        const clock = fakeClock();
        const store = new MemoryPartStore();
        await stage(store, 1, makeData(1000));

        const emitted: [number, number][] = [];
        const uploadPart: UploaderOpts['uploadPart'] = (_url, _body, hooks) => {
            // 40 XHR progress events across 1s — the rate a real part upload
            // delivers, and a message per event is what janks the main thread.
            for (let i = 1; i <= 40; i++) {
                hooks.onProgress(i * 25);
                clock.advance(25);
            }
            return Promise.resolve({ etag: 'etag-1' });
        };

        await runUploaders(
            makeQueue([{ partNumber: 1, size: 1000 }]),
            baseOpts({
                store,
                uploadPart,
                maxConcurrent: 1,
                progressEmitMs: 250,
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
                onProgress: (sent, atMs) => {
                    emitted.push([sent, atMs]);
                },
            }),
        );

        expect(emitted).toEqual([
            [25, 0],
            [275, 250],
            [525, 500],
            [775, 750],
            [1000, 975], // the part's final byte, never coalesced away
            [1000, 1000], // part completion
        ]);
    });

    it("reports a part's final byte even when it lands inside a coalescing window", async () => {
        const clock = fakeClock();
        const store = new MemoryPartStore();
        await stage(store, 1, makeData(100));

        const emitted: number[] = [];
        const uploadPart: UploaderOpts['uploadPart'] = (_url, _body, hooks) => {
            hooks.onProgress(40);
            hooks.onProgress(100); // same millisecond as the leading emit
            return Promise.resolve({ etag: 'etag-1' });
        };

        await runUploaders(
            makeQueue([{ partNumber: 1, size: 100 }]),
            baseOpts({
                store,
                uploadPart,
                maxConcurrent: 1,
                progressEmitMs: 250,
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
                onProgress: (sent) => {
                    emitted.push(sent);
                },
            }),
        );

        expect(emitted).toEqual([40, 100, 100]);
    });

    it('emits on every part completion regardless of cadence', async () => {
        const clock = fakeClock();
        const store = new MemoryPartStore();
        await stage(store, 1, makeData(4));
        await stage(store, 2, makeData(4));
        await stage(store, 3, makeData(2));

        const emitted: number[] = [];
        // Parts that finish without a single byte-progress event, all inside
        // one coalescing window: completion totals must still be reported.
        const uploadPart: UploaderOpts['uploadPart'] = (url) =>
            Promise.resolve({ etag: `etag-${url.slice(-1)}` });

        await runUploaders(
            makeQueue([
                { partNumber: 1, size: 4 },
                { partNumber: 2, size: 4 },
                { partNumber: 3, size: 2 },
            ]),
            baseOpts({
                store,
                uploadPart,
                maxConcurrent: 1,
                progressEmitMs: 250,
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
                onProgress: (sent) => {
                    emitted.push(sent);
                },
            }),
        );

        expect(emitted).toEqual([4, 8, 10]);
    });

    it('halves the pool when the bucket returns 429', async () => {
        const { store, urls, queue } = await pool(12);
        const controller = createConcurrencyController({ initial: 8, min: 2, max: 8 });
        let served = 0;

        const etags = await runUploaders(
            queue,
            baseOpts({
                store,
                urls,
                maxConcurrent: 8,
                concurrency: controller,
                setTimeoutFn: (fn: () => void, ms: number) => setTimeout(fn, ms),
                uploadPart: (_url, body, hooks) => {
                    served += 1;
                    if (served === 3) {
                        return Promise.reject(new Error('HTTP 429 Too Many Requests'));
                    }
                    hooks.onProgress(body.size);
                    return Promise.resolve({ etag: `etag-${served}` });
                },
            }),
        );

        expect(controller.pushbacks()).toBe(1);
        expect(controller.target()).toBe(4);
        expect(etags.size).toBe(12);
    });

    it('does not shrink on an offline-shaped failure', async () => {
        // A dead link is not congestion — it has its own park-and-poll path.
        const { store, urls, queue } = await pool(6);
        const controller = createConcurrencyController({ initial: 8, min: 2, max: 8 });
        let served = 0;

        const etags = await runUploaders(
            queue,
            baseOpts({
                store,
                urls,
                maxConcurrent: 8,
                concurrency: controller,
                setTimeoutFn: (fn: () => void, ms: number) => setTimeout(fn, ms),
                uploadPart: (_url, body, hooks) => {
                    served += 1;
                    if (served === 2) {
                        return Promise.reject(new Error('HTTP 0'));
                    }
                    hooks.onProgress(body.size);
                    return Promise.resolve({ etag: `etag-${served}` });
                },
            }),
        );

        expect(controller.pushbacks()).toBe(0);
        expect(controller.target()).toBe(8);
        expect(etags.size).toBe(6);
    });

    it('finishes an in-flight part rather than aborting it when shrinking', async () => {
        // Aborting mid-part to shrink would waste exactly the bytes the pool
        // exists to conserve.
        const { store, urls, queue } = await pool(8);
        const controller = createConcurrencyController({ initial: 4, min: 2, max: 4 });
        const aborted: number[] = [];
        const completed: number[] = [];
        let served = 0;

        const etags = await runUploaders(
            queue,
            baseOpts({
                store,
                urls,
                maxConcurrent: 4,
                concurrency: controller,
                uploadPart: (_url, body, hooks) => {
                    served += 1;
                    const mine = served;
                    if (mine === 1) {
                        controller.onPushback(Date.now());
                    }
                    hooks.signal.addEventListener('abort', () => aborted.push(mine));
                    hooks.onProgress(body.size);
                    completed.push(mine);
                    return Promise.resolve({ etag: `etag-${mine}` });
                },
            }),
        );

        expect(controller.target()).toBe(2);
        expect(aborted).toEqual([]);
        expect(completed).toHaveLength(8);
        expect(etags.size).toBe(8);
    });

    it('reports a worker idling on an empty queue', async () => {
        // Slow staging must not read as "the pool is the bottleneck".
        const clock = fakeClock();
        const { store, urls, parts } = await pool(3);
        const controller = createConcurrencyController({ initial: 2, min: 2, max: 8 });
        const onIdle = vi.spyOn(controller, 'onIdle');

        await runUploaders(
            slowQueue(parts, clock, 500),
            baseOpts({
                store,
                urls,
                maxConcurrent: 2,
                concurrency: controller,
                now: clock.now,
                setTimeoutFn: clock.setTimeoutFn,
                uploadPart: (_url, body, hooks) => {
                    hooks.onProgress(body.size);
                    return Promise.resolve({ etag: 'etag-1' });
                },
            }),
        );

        expect(onIdle).toHaveBeenCalled();
    });

    it('grows the pool while saturated and keeps uploading through the resize', async () => {
        // Growth rides the progress cadence: each part costs a full probe
        // window of wall clock, so the controller sees a clean window per part.
        const clock = fakeClock();
        const { store, urls, queue } = await pool(12);
        const controller = createConcurrencyController({
            initial: 2,
            min: 2,
            max: 4,
            probeIntervalMs: 10_000,
        });
        let inFlight = 0;
        let peakInFlight = 0;

        const etags = await runUploaders(
            queue,
            baseOpts({
                store,
                urls,
                maxConcurrent: 2,
                concurrency: controller,
                now: clock.now,
                setTimeoutFn: (fn: () => void, ms: number) => setTimeout(fn, ms),
                uploadPart: async (_url, body, hooks) => {
                    inFlight += 1;
                    peakInFlight = Math.max(peakInFlight, inFlight);
                    clock.advance(10_000);
                    hooks.onProgress(body.size);
                    // Park on a real macrotask so overlapping workers are
                    // observable rather than serialised by the microtask queue.
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    inFlight -= 1;
                    return { etag: `etag-${body.size}` };
                },
            }),
        );

        expect(controller.target()).toBe(4);
        expect(peakInFlight).toBeGreaterThan(2);
        expect(etags.size).toBe(12);
    });

    it('uploads every part regardless of pool resizing', async () => {
        const { store, urls, queue } = await pool(20);
        const controller = createConcurrencyController({ initial: 2, min: 2, max: 8 });

        const etags = await runUploaders(
            queue,
            baseOpts({
                store,
                urls,
                maxConcurrent: 2,
                concurrency: controller,
                uploadPart: () => Promise.resolve({ etag: 'etag' }),
            }),
        );

        expect(etags.size).toBe(20);
        expect([...etags.keys()].sort((a, b) => a - b)).toEqual(
            Array.from({ length: 20 }, (_, i) => i + 1),
        );
    });
});
