import { UPLOAD_LIMITS } from '@bolter/shared';
import { describe, expect, it } from 'vitest';
import {
    calculateEncryptedSize,
    createDecryptionStream,
    ECE_ENCRYPTED_RECORD_SIZE,
    ECE_RECORD_SIZE,
    ECE_VERSION,
    Keychain,
} from '@/lib/crypto';
import { type EngineDeps, runEngine } from '../engine';
import { MemoryPartStore, type PartStore } from '../part-store';
import type { EngineJob, WorkerToClient } from '../protocol';
import type {
    CompletionEnvelope,
    EngineLease,
    EnginePartRecord,
    EngineStateStore,
    ProducerCheckpoint,
} from '../state';

const MIN = UPLOAD_LIMITS.MIN_PART_SIZE; // 5,242,880 — legal non-trailing part size

function makeData(size: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = i % 256;
    }
    return data;
}

// biome-ignore lint/suspicious/useAwait: async generator builds the AsyncIterable the PartStore contract requires
async function* chunksOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    yield bytes;
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/** Concatenate uploaded part bodies in part order. */
function concatBodies(bodies: Map<number, Uint8Array>): Uint8Array {
    const parts = [...bodies.entries()].sort((a, b) => a[0] - b[0]);
    return concat(parts.map(([, bytes]) => bytes));
}

/** `toEqual` walks typed arrays element-by-element (~18s on 10 MiB) — compare
 * multi-megabyte payloads with a linear scan instead. */
function bytesEqual(a: Uint8Array | undefined, b: Uint8Array): boolean {
    if (!a || a.byteLength !== b.byteLength) {
        return false;
    }
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function expectBytesEqual(actual: Uint8Array | undefined, expected: Uint8Array): void {
    expect(actual?.byteLength).toBe(expected.byteLength);
    expect(bytesEqual(actual, expected)).toBe(true);
}

async function pipeBytes(
    chunks: Uint8Array[],
    stream: TransformStream<Uint8Array, Uint8Array>,
): Promise<Uint8Array> {
    const writer = stream.writable.getWriter();
    const writePromise = (async () => {
        for (const chunk of chunks) {
            await writer.write(chunk);
        }
        await writer.close();
    })();
    writePromise.catch(() => undefined);
    const reader = stream.readable.getReader();
    const out: Uint8Array[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        out.push(value);
    }
    await writePromise;
    return concat(out);
}

async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 500; i++) {
        if (cond()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('condition not reached');
}

/** Fake `EngineStateStore` backed by Maps, recording writes into `log`. */
function fakeState(log: string[] = []) {
    const leases = new Map<string, EngineLease>();
    const envelopes = new Map<string, CompletionEnvelope>();
    const checkpoints = new Map<string, ProducerCheckpoint>();
    const parts = new Map<string, EnginePartRecord>();
    const state: EngineStateStore = {
        putLease(l) {
            log.push('putLease');
            leases.set(l.fileId, l);
            return Promise.resolve();
        },
        getLease(fileId) {
            return Promise.resolve(leases.get(fileId));
        },
        putEnvelope(e) {
            log.push('putEnvelope');
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
            parts.set(`${p.fileId}:${p.partNumber}`, p);
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
            log.push('clearUpload');
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
    return { state };
}

/** `PartStore` wrapper recording stage/delete/destroy calls into `log`. */
class RecordingPartStore implements PartStore {
    constructor(
        private readonly inner: PartStore,
        private readonly log: string[],
    ) {}

    stagePart(partNumber: number, chunks: AsyncIterable<Uint8Array>): Promise<{ size: number }> {
        this.log.push(`stagePart:${partNumber}`);
        return this.inner.stagePart(partNumber, chunks);
    }

    readPart(partNumber: number): Promise<Blob> {
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
        this.log.push('destroy');
        return this.inner.destroy();
    }
}

interface Harness {
    deps: EngineDeps;
    events: WorkerToClient[];
    log: string[];
    state: EngineStateStore;
    store: PartStore;
    bodies: Map<number, Uint8Array>;
    completions: { parts: { PartNumber: number; ETag: string }[]; actualSize: number }[];
    aborts: { fileId: string; uploadToken?: string }[];
    /** When set, uploads of these part numbers reject with a network error. */
    failingParts: Set<number>;
}

function makeHarness(
    urls: string[],
    opts?: { uploadPart?: (harness: Harness) => EngineDeps['uploadPart']; store?: PartStore },
): Harness {
    const log: string[] = [];
    const { state } = fakeState(log);
    const store = new RecordingPartStore(opts?.store ?? new MemoryPartStore(), log);
    const events: WorkerToClient[] = [];
    const bodies = new Map<number, Uint8Array>();
    const completions: Harness['completions'] = [];
    const aborts: Harness['aborts'] = [];
    const failingParts = new Set<number>();

    const harness: Harness = {
        events,
        log,
        state,
        store,
        bodies,
        completions,
        aborts,
        failingParts,
        deps: undefined as unknown as EngineDeps,
    };

    const defaultUploadPart: EngineDeps['uploadPart'] = async (url, body, hooks) => {
        const partNumber = urls.indexOf(url) + 1;
        if (harness.failingParts.has(partNumber)) {
            log.push(`uploadFail:${partNumber}`);
            throw new Error('network error');
        }
        const bytes = new Uint8Array(await body.arrayBuffer());
        bodies.set(partNumber, bytes);
        log.push(`uploadPart:${partNumber}`);
        hooks.onProgress(bytes.byteLength);
        return { etag: `etag-${partNumber}` };
    };

    harness.deps = {
        store,
        state,
        uploadPart: opts?.uploadPart ? opts.uploadPart(harness) : defaultUploadPart,
        completeUpload(_envelope, parts, actualSize) {
            log.push('completeUpload');
            completions.push({ parts, actualSize });
            return Promise.resolve();
        },
        refreshPartUrls() {
            return Promise.resolve(urls);
        },
        abortUpload(fileId, uploadToken) {
            log.push('abortUpload');
            aborts.push({ fileId, uploadToken });
            return Promise.resolve();
        },
        now: () => Date.now(),
        isOnline: () => true,
        onEvent(e) {
            if (e.type === 'cancelled') {
                log.push('event:cancelled');
            }
            events.push(e);
        },
    };
    return harness;
}

function makeJob(
    over: Partial<EngineJob> &
        Pick<EngineJob, 'source' | 'partUrls' | 'partSize' | 'declaredTotalSize'>,
): EngineJob {
    return {
        fileId: 'up_engine',
        uploadId: 'mp-upload-1',
        uploadToken: 'tok-1',
        ownerToken: 'owner-1',
        encrypted: false,
        maxConcurrent: 2,
        ...over,
    };
}

function makeEnvelope(fileId: string, expectedSize: number, encrypted = false): CompletionEnvelope {
    return {
        fileId,
        metadata: 'metadata-b64',
        authKeyB64: 'auth-key-b64',
        manifest: [{ name: 'a.bin', size: expectedSize, type: 'application/octet-stream' }],
        expectedSize,
        encrypted,
        timeLimit: 86_400,
        downloadLimit: 10,
    };
}

const urlsFor = (n: number) => Array.from({ length: n }, (_, i) => `https://s3/part/${i + 1}`);

const FAST = { maxAttemptsPerPart: 2, retryDelayMs: () => 0 };

describe('runEngine', () => {
    it('runs a single-file job end-to-end: stage, upload, complete, clear', async () => {
        const total = 2 * MIN + 12;
        const data = makeData(total);
        const urls = urlsFor(3);
        const h = makeHarness(urls);
        const job = makeJob({
            source: { kind: 'file', file: new File([data], 'a.bin') },
            partUrls: urls,
            partSize: MIN,
            declaredTotalSize: total,
        });
        const envelope = makeEnvelope(job.fileId, total);

        const result = await runEngine(job, envelope, h.deps, new AbortController().signal);

        expect(result).toEqual({ actualSize: total });
        expect(h.completions).toHaveLength(1);
        expect(h.completions[0].parts).toEqual([
            { PartNumber: 1, ETag: 'etag-1' },
            { PartNumber: 2, ETag: 'etag-2' },
            { PartNumber: 3, ETag: 'etag-3' },
        ]);
        expect(h.completions[0].actualSize).toBe(total);
        expectBytesEqual(concatBodies(h.bodies), data);

        // Events: progress along the way, done (with the actual size) last.
        expect(h.events[h.events.length - 1]).toEqual({ type: 'done', actualSize: total });
        expect(h.events.some((e) => e.type === 'progress' && e.totalBytes === total)).toBe(true);

        // Lease + envelope were durable before any staging write.
        expect(h.log.indexOf('putLease')).toBeLessThan(h.log.indexOf('stagePart:1'));
        expect(h.log.indexOf('putEnvelope')).toBeLessThan(h.log.indexOf('stagePart:1'));

        // Finalize ordering: completeUpload → store.destroy → state.clearUpload.
        expect(h.log.indexOf('completeUpload')).toBeLessThan(h.log.indexOf('destroy'));
        expect(h.log.indexOf('destroy')).toBeLessThan(h.log.indexOf('clearUpload'));
        expect(await h.state.getLease(job.fileId)).toBeUndefined();
        expect(await h.state.getParts(job.fileId)).toEqual([]);
    });

    it('cancel mid-flight aborts the server upload, acks, and tears down local state', async () => {
        const data = makeData(12);
        const urls = urlsFor(3);
        const h = makeHarness(urls, {
            uploadPart: (harness) => async (url, body, hooks) => {
                const partNumber = urls.indexOf(url) + 1;
                if (partNumber === 1) {
                    const bytes = new Uint8Array(await body.arrayBuffer());
                    harness.bodies.set(partNumber, bytes);
                    hooks.onProgress(bytes.byteLength);
                    return { etag: 'etag-1' };
                }
                // Hang until the engine aborts the attempt.
                return new Promise((_resolve, reject) => {
                    hooks.signal.addEventListener(
                        'abort',
                        () => reject(new Error('Upload aborted')),
                        { once: true },
                    );
                });
            },
        });
        const job = makeJob({
            source: { kind: 'blob', blob: new Blob([data]) },
            partUrls: urls,
            partSize: 4,
            declaredTotalSize: 12,
        });
        const canceller = new AbortController();

        const run = runEngine(job, makeEnvelope(job.fileId, 12), h.deps, canceller.signal);
        run.catch(() => undefined);
        await waitFor(() => h.log.includes('deletePart:1'));
        canceller.abort();

        await expect(run).rejects.toThrow(/cancel/i);
        expect(h.aborts).toEqual([{ fileId: job.fileId, uploadToken: 'tok-1' }]);
        // Ordered ack [R6]: server abort → cancelled event → local teardown.
        expect(h.log.indexOf('abortUpload')).toBeLessThan(h.log.indexOf('event:cancelled'));
        expect(h.log.indexOf('event:cancelled')).toBeLessThan(h.log.indexOf('destroy'));
        expect(await h.state.getLease(job.fileId)).toBeUndefined();
        expect(h.completions).toEqual([]);
    });

    it('a retryable terminal failure emits error{retryable:true} and preserves state', async () => {
        const data = makeData(12);
        const urls = urlsFor(3);
        const h = makeHarness(urls);
        h.failingParts.add(2);
        const job = makeJob({
            source: { kind: 'blob', blob: new Blob([data]) },
            partUrls: urls,
            partSize: 4,
            declaredTotalSize: 12,
            maxConcurrent: 1,
        });

        await expect(
            runEngine(
                job,
                makeEnvelope(job.fileId, 12),
                h.deps,
                new AbortController().signal,
                FAST,
            ),
        ).rejects.toThrow('network error');

        expect(h.events[h.events.length - 1]).toEqual({
            type: 'error',
            message: expect.stringContaining('network error'),
            retryable: true,
            stage: 'uploader',
        });
        // Resume material is intact: lease, eof checkpoint, part records.
        expect(await h.state.getLease(job.fileId)).toBeDefined();
        expect((await h.state.getCheckpoint(job.fileId))?.eofReached).toBe(true);
        const parts = await h.state.getParts(job.fileId);
        expect(parts).toHaveLength(3);
        expect(parts[0]).toMatchObject({ partNumber: 1, uploaded: true, etag: 'etag-1' });
        expect(parts[1]).toMatchObject({ partNumber: 2, staged: true, uploaded: false });
        // The staged part is still readable, byte-identical, for a later resume.
        expect(new Uint8Array(await (await h.store.readPart(2)).arrayBuffer())).toEqual(
            data.slice(4, 8),
        );
        expect(h.log).not.toContain('destroy');
        expect(h.log).not.toContain('clearUpload');
        expect(h.completions).toEqual([]);
    });

    it('a second run finishes from staged state without re-producing parts', async () => {
        const total = 2 * MIN + 12;
        const data = makeData(total);
        const urls = urlsFor(3);
        const h = makeHarness(urls);
        h.failingParts.add(2);
        const job = makeJob({
            source: { kind: 'blob', blob: new Blob([data]) },
            partUrls: urls,
            partSize: MIN,
            declaredTotalSize: total,
            maxConcurrent: 1,
        });
        const envelope = makeEnvelope(job.fileId, total);

        await expect(
            runEngine(job, envelope, h.deps, new AbortController().signal, FAST),
        ).rejects.toThrow('network error');

        h.failingParts.clear();
        const result = await runEngine(job, envelope, h.deps, new AbortController().signal, FAST);

        expect(result).toEqual({ actualSize: total });
        expect(h.events[h.events.length - 1]).toEqual({ type: 'done', actualSize: total });
        // All staging happened in run 1 — run 2 only uploaded and completed.
        expect(h.log.filter((e) => e.startsWith('stagePart:'))).toEqual([
            'stagePart:1',
            'stagePart:2',
            'stagePart:3',
        ]);
        // Part 1 was uploaded exactly once (run 1's ETag was reused).
        expect(h.log.filter((e) => e === 'uploadPart:1')).toHaveLength(1);
        expect(h.completions).toHaveLength(1);
        expect(h.completions[0].parts).toEqual([
            { PartNumber: 1, ETag: 'etag-1' },
            { PartNumber: 2, ETag: 'etag-2' },
            { PartNumber: 3, ETag: 'etag-3' },
        ]);
        expectBytesEqual(concatBodies(h.bodies), data);
        expect(await h.state.getLease(job.fileId)).toBeUndefined();
    });

    it('resumes production from the persisted checkpoint (file source)', async () => {
        const total = 2 * MIN + 12;
        const data = makeData(total);
        const urls = urlsFor(3);
        const h = makeHarness(urls);
        const job = makeJob({
            source: { kind: 'file', file: new File([data], 'a.bin') },
            partUrls: urls,
            partSize: MIN,
            declaredTotalSize: total,
            maxConcurrent: 1,
        });
        const envelope = makeEnvelope(job.fileId, total);

        // Interrupted earlier run: part 1 uploaded (bytes already deleted),
        // production checkpointed at the part-2 boundary.
        await h.state.putLease({
            fileId: job.fileId,
            uploadId: job.uploadId,
            uploadToken: job.uploadToken,
            ownerToken: job.ownerToken,
            createdAt: 1,
            engineVersion: 1,
        });
        await h.state.putEnvelope(envelope);
        await h.state.putPart({
            fileId: job.fileId,
            partNumber: 1,
            size: MIN,
            staged: true,
            uploaded: true,
            etag: 'etag-pre-1',
        });
        await h.state.putCheckpoint({
            fileId: job.fileId,
            nextPartNumber: 2,
            sourceOffset: MIN,
            eceCounter: 0,
            eofReached: false,
            finalRecordEmitted: false,
        });

        const result = await runEngine(job, envelope, h.deps, new AbortController().signal);

        expect(result).toEqual({ actualSize: total });
        // Only parts 2 and 3 were produced and uploaded, from the exact offset.
        expect(h.log.filter((e) => e.startsWith('stagePart:'))).toEqual([
            'stagePart:2',
            'stagePart:3',
        ]);
        expect(h.log).not.toContain('uploadPart:1');
        expectBytesEqual(h.bodies.get(2), data.slice(MIN, 2 * MIN));
        expectBytesEqual(h.bodies.get(3), data.slice(2 * MIN));
        expect(h.completions[0].parts).toEqual([
            { PartNumber: 1, ETag: 'etag-pre-1' },
            { PartNumber: 2, ETag: 'etag-2' },
            { PartNumber: 3, ETag: 'etag-3' },
        ]);
        expect(h.completions[0].actualSize).toBe(total);
    });

    it('tags OPFS quota exhaustion with the stager-quota failure stage', async () => {
        // Telemetry must distinguish quota exhaustion from transport faults
        // and completion rejections [R16].
        const urls = urlsFor(3);
        const h = makeHarness(urls, { store: new MemoryPartStore({ quotaBytes: 2 }) });
        const job = makeJob({
            source: { kind: 'blob', blob: new Blob([makeData(12)]) },
            partUrls: urls,
            partSize: 4,
            declaredTotalSize: 12,
            maxConcurrent: 1,
        });

        await expect(
            runEngine(
                job,
                makeEnvelope(job.fileId, 12),
                h.deps,
                new AbortController().signal,
                FAST,
            ),
        ).rejects.toThrow(/quota/);

        expect(h.events[h.events.length - 1]).toMatchObject({
            type: 'error',
            retryable: true, // quota is a typed recoverable failure
            stage: 'stager-quota',
        });
    });

    it('does not double-queue a part staged just before the checkpoint write (crash window)', async () => {
        const total = 2 * MIN + 12;
        const data = makeData(total);
        const urls = urlsFor(3);
        const h = makeHarness(urls);
        const job = makeJob({
            source: { kind: 'file', file: new File([data], 'a.bin') },
            partUrls: urls,
            partSize: MIN,
            declaredTotalSize: total,
            maxConcurrent: 1,
        });
        const envelope = makeEnvelope(job.fileId, total);

        // Interrupted run that crashed between `putPart(2, staged)` and
        // `putCheckpoint(3)`: part 1 uploaded, part 2's bytes and staged
        // record are durable, but the checkpoint still names part 2 as the
        // next part to produce — production will re-stage it.
        await h.state.putLease({
            fileId: job.fileId,
            uploadId: job.uploadId,
            uploadToken: job.uploadToken,
            ownerToken: job.ownerToken,
            createdAt: 1,
            engineVersion: 1,
        });
        await h.state.putEnvelope(envelope);
        await h.state.putPart({
            fileId: job.fileId,
            partNumber: 1,
            size: MIN,
            staged: true,
            uploaded: true,
            etag: 'etag-pre-1',
        });
        await h.state.putPart({
            fileId: job.fileId,
            partNumber: 2,
            size: MIN,
            staged: true,
            uploaded: false,
        });
        await h.store.stagePart(2, chunksOf(data.slice(MIN, 2 * MIN)));
        await h.state.putCheckpoint({
            fileId: job.fileId,
            nextPartNumber: 2,
            sourceOffset: MIN,
            eceCounter: 0,
            eofReached: false,
            finalRecordEmitted: false,
        });

        const seededEntries = h.log.length; // ignore the seeding writes above

        const result = await runEngine(job, envelope, h.deps, new AbortController().signal);

        expect(result).toEqual({ actualSize: total });
        // Part 2 was re-produced from the checkpoint and uploaded exactly
        // once — the stale staged record did not feed the queue a duplicate
        // whose readPart would race the winner's delete-after-upload.
        const runLog = h.log.slice(seededEntries);
        expect(runLog.filter((e) => e === 'uploadPart:2')).toHaveLength(1);
        expect(runLog.filter((e) => e === 'stagePart:2')).toHaveLength(1);
        expect(h.completions).toHaveLength(1);
        expect(h.completions[0].parts).toEqual([
            { PartNumber: 1, ETag: 'etag-pre-1' },
            { PartNumber: 2, ETag: 'etag-2' },
            { PartNumber: 3, ETag: 'etag-3' },
        ]);
        expectBytesEqual(concatBodies(h.bodies), data.slice(MIN));
        expect(h.events[h.events.length - 1]).toEqual({ type: 'done', actualSize: total });
    });

    it('encrypted job uploads ciphertext cut at exact record multiples', async () => {
        const keychain = new Keychain();
        const partSize = 80 * ECE_ENCRYPTED_RECORD_SIZE; // 5,244,240 ≥ 5 MiB minimum
        const plaintext = makeData(2 * 80 * ECE_RECORD_SIZE + 1000);
        const declaredTotalSize = calculateEncryptedSize(plaintext.byteLength);
        const urls = urlsFor(3);
        const h = makeHarness(urls);
        const job = makeJob({
            source: { kind: 'blob', blob: new Blob([plaintext]) },
            partUrls: urls,
            partSize,
            declaredTotalSize,
            encrypted: true,
            secretKeyB64: keychain.secretKeyB64,
        });

        const result = await runEngine(
            job,
            makeEnvelope(job.fileId, declaredTotalSize, true),
            h.deps,
            new AbortController().signal,
        );

        expect(result).toEqual({ actualSize: declaredTotalSize });
        // Non-final parts are exact encrypted-record multiples of the part size.
        expect(h.bodies.get(1)?.byteLength).toBe(partSize);
        expect(h.bodies.get(2)?.byteLength).toBe(partSize);
        expect(partSize % ECE_ENCRYPTED_RECORD_SIZE).toBe(0);
        // Uploaded bytes are ciphertext, not the source plaintext…
        expect(bytesEqual(h.bodies.get(1), plaintext.slice(0, partSize))).toBe(false);
        // …and the concatenated payload decrypts back to it.
        const ordered = [...h.bodies.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
        const decrypted = await pipeBytes(
            ordered,
            createDecryptionStream(keychain, { eceVersion: ECE_VERSION }),
        );
        expectBytesEqual(decrypted, plaintext);
    });
});
