import { UPLOAD_LIMITS } from '@bolter/shared';
import { describe, expect, it } from 'vitest';
import type { EngineDeps } from '../engine';
import { MemoryPartStore, type PartStore } from '../part-store';
import type { WorkerToClient } from '../protocol';
import { executeResume, planResume, ResumeNeedsSourceError } from '../resume';
import type {
    CompletionEnvelope,
    EngineLease,
    EnginePartRecord,
    EngineStateStore,
    ProducerCheckpoint,
} from '../state';

const MIN = UPLOAD_LIMITS.MIN_PART_SIZE; // 5,242,880 — legal non-trailing part size
const FILE_ID = 'up_resume';

function makeLease(over: Partial<EngineLease> = {}): EngineLease {
    return {
        fileId: FILE_ID,
        uploadId: 'mp-upload-1',
        uploadToken: 'tok-1',
        ownerToken: 'owner-1',
        createdAt: 1,
        engineVersion: 1,
        ...over,
    };
}

function makeEnvelope(over: Partial<CompletionEnvelope> = {}): CompletionEnvelope {
    return {
        fileId: FILE_ID,
        metadata: 'metadata-b64',
        authKeyB64: 'auth-key-b64',
        manifest: [{ name: 'a.bin', size: 12, type: 'application/octet-stream' }],
        expectedSize: 12,
        encrypted: false,
        timeLimit: 86_400,
        downloadLimit: 10,
        ...over,
    };
}

const MULTI_MANIFEST = [
    { name: 'a.bin', size: 6, type: 'application/octet-stream' },
    { name: 'b.bin', size: 6, type: 'application/octet-stream' },
];

function eofCheckpoint(
    nextPartNumber: number,
    over: Partial<ProducerCheckpoint> = {},
): ProducerCheckpoint {
    return {
        fileId: FILE_ID,
        nextPartNumber,
        sourceOffset: 12,
        eceCounter: 0,
        eofReached: true,
        finalRecordEmitted: true,
        ...over,
    };
}

function midCheckpoint(nextPartNumber: number): ProducerCheckpoint {
    return {
        fileId: FILE_ID,
        nextPartNumber,
        sourceOffset: 4,
        eceCounter: 0,
        eofReached: false,
        finalRecordEmitted: false,
    };
}

function stagedPart(partNumber: number, size: number): EnginePartRecord {
    return { fileId: FILE_ID, partNumber, size, staged: true, uploaded: false };
}

function uploadedPart(partNumber: number, size: number): EnginePartRecord {
    return {
        fileId: FILE_ID,
        partNumber,
        size,
        staged: true,
        uploaded: true,
        etag: `etag-pre-${partNumber}`,
    };
}

describe('planResume', () => {
    it('replays completion when every produced part is uploaded with an ETag', () => {
        const plan = planResume(makeLease(), makeEnvelope(), eofCheckpoint(4), [
            uploadedPart(1, 4),
            uploadedPart(2, 4),
            uploadedPart(3, 4),
        ]);
        expect(plan).toEqual({ action: 'replay-complete' });
    });

    it('finishes from staged parts when production reached EOF but uploads are incomplete', () => {
        const plan = planResume(makeLease(), makeEnvelope(), eofCheckpoint(4), [
            uploadedPart(1, 4),
            stagedPart(2, 4),
            stagedPart(3, 4),
        ]);
        expect(plan).toEqual({ action: 'finish-staged' });
    });

    it('a gap in uploaded ETags is never replay: staged gap → finish-staged', () => {
        const plan = planResume(makeLease(), makeEnvelope(), eofCheckpoint(4), [
            uploadedPart(1, 4),
            stagedPart(2, 4),
            uploadedPart(3, 4),
        ]);
        expect(plan).toEqual({ action: 'finish-staged' });
    });

    it('a missing part record falls past replay and finish-staged to need-source', () => {
        const plan = planResume(makeLease(), makeEnvelope(), eofCheckpoint(4), [
            uploadedPart(1, 4),
            uploadedPart(3, 4),
        ]);
        expect(plan).toEqual({ action: 'need-source', kind: 'single' });
    });

    it('multi-file with EOF and all parts staged is finish-staged (crash-window promise)', () => {
        const plan = planResume(
            makeLease(),
            makeEnvelope({ manifest: MULTI_MANIFEST }),
            eofCheckpoint(3),
            [stagedPart(1, 6), stagedPart(2, 6)],
        );
        expect(plan).toEqual({ action: 'finish-staged' });
    });

    it('incomplete production needs a source: single-file kind', () => {
        const plan = planResume(makeLease(), makeEnvelope(), midCheckpoint(2), [stagedPart(1, 4)]);
        expect(plan).toEqual({ action: 'need-source', kind: 'single' });
    });

    it('incomplete production needs a source: multi-file kind', () => {
        const plan = planResume(
            makeLease(),
            makeEnvelope({ manifest: MULTI_MANIFEST }),
            midCheckpoint(2),
            [stagedPart(1, 6)],
        );
        expect(plan).toEqual({ action: 'need-source', kind: 'multi' });
    });

    it('a missing checkpoint means production never committed — need-source', () => {
        const plan = planResume(makeLease(), makeEnvelope(), undefined, []);
        expect(plan).toEqual({ action: 'need-source', kind: 'single' });
    });

    it('unencrypted EOF without finalRecordEmitted still replays', () => {
        const plan = planResume(
            makeLease(),
            makeEnvelope(),
            eofCheckpoint(2, { finalRecordEmitted: false }),
            [uploadedPart(1, 12)],
        );
        expect(plan).toEqual({ action: 'replay-complete' });
    });

    it('encrypted EOF without the final ECE record is truncated ciphertext — need-source', () => {
        const plan = planResume(
            makeLease(),
            makeEnvelope({ encrypted: true, secretKeyB64: 'key-b64' }),
            eofCheckpoint(2, { finalRecordEmitted: false }),
            [uploadedPart(1, 12)],
        );
        expect(plan).toEqual({ action: 'need-source', kind: 'single' });
    });

    it('no lease is unrecoverable', () => {
        const plan = planResume(undefined, makeEnvelope(), eofCheckpoint(2), [uploadedPart(1, 12)]);
        expect(plan).toEqual({ action: 'unrecoverable' });
    });

    it('no envelope is unrecoverable', () => {
        const plan = planResume(makeLease(), undefined, eofCheckpoint(2), [uploadedPart(1, 12)]);
        expect(plan).toEqual({ action: 'unrecoverable' });
    });
});

// --- executeResume harness ------------------------------------------------

function makeData(size: number, seed = 0): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = (i + seed) % 256;
    }
    return data;
}

/** `toEqual` walks typed arrays element-by-element — compare multi-megabyte
 * payloads with a linear scan instead. */
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

// biome-ignore lint/suspicious/useAwait: async generator builds the AsyncIterable the PartStore contract requires
async function* chunksOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    yield bytes;
}

/** Fake `EngineStateStore` backed by Maps, recording writes into `log`. */
function fakeState(log: string[]) {
    const leases = new Map<string, EngineLease>();
    const envelopes = new Map<string, CompletionEnvelope>();
    const checkpoints = new Map<string, ProducerCheckpoint>();
    const parts = new Map<string, EnginePartRecord>();
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
    return state;
}

interface Harness {
    deps: EngineDeps;
    events: WorkerToClient[];
    log: string[];
    state: EngineStateStore;
    store: PartStore;
    bodies: Map<number, Uint8Array>;
    completions: { parts: { PartNumber: number; ETag: string }[]; actualSize: number }[];
    refreshCalls: { fileId: string; uploadToken?: string }[];
}

function makeHarness(urls: string[]): Harness {
    const log: string[] = [];
    const state = fakeState(log);
    const inner = new MemoryPartStore();
    const store: PartStore = {
        stagePart: (partNumber, chunks) => inner.stagePart(partNumber, chunks),
        readPart: (partNumber) => inner.readPart(partNumber),
        deletePart: (partNumber) => inner.deletePart(partNumber),
        listParts: () => inner.listParts(),
        destroy: () => {
            log.push('destroy');
            return inner.destroy();
        },
    };
    const events: WorkerToClient[] = [];
    const bodies = new Map<number, Uint8Array>();
    const completions: Harness['completions'] = [];
    const refreshCalls: Harness['refreshCalls'] = [];

    const deps: EngineDeps = {
        store,
        state,
        async uploadPart(url, body, hooks) {
            const partNumber = urls.indexOf(url) + 1;
            const bytes = new Uint8Array(await body.arrayBuffer());
            bodies.set(partNumber, bytes);
            log.push(`uploadPart:${partNumber}`);
            hooks.onProgress(bytes.byteLength);
            return { etag: `etag-${partNumber}` };
        },
        completeUpload(_envelope, parts, actualSize) {
            log.push('completeUpload');
            completions.push({ parts, actualSize });
            return Promise.resolve();
        },
        refreshPartUrls(fileId, uploadToken) {
            log.push('refreshPartUrls');
            refreshCalls.push({ fileId, uploadToken });
            return Promise.resolve(urls);
        },
        abortUpload() {
            log.push('abortUpload');
            return Promise.resolve();
        },
        now: () => Date.now(),
        isOnline: () => true,
        onEvent(e) {
            events.push(e);
        },
    };
    return { deps, events, log, state, store, bodies, completions, refreshCalls };
}

const urlsFor = (n: number) => Array.from({ length: n }, (_, i) => `https://s3/part/${i + 1}`);

describe('executeResume', () => {
    it('replay-complete: replays /upload/complete from persisted ETags, no uploads', async () => {
        const total = 2 * MIN + 12;
        const h = makeHarness(urlsFor(3));
        await h.state.putLease(makeLease());
        await h.state.putEnvelope(makeEnvelope({ expectedSize: total }));
        await h.state.putCheckpoint(eofCheckpoint(4, { sourceOffset: total }));
        await h.state.putPart(uploadedPart(1, MIN));
        await h.state.putPart(uploadedPart(2, MIN));
        await h.state.putPart(uploadedPart(3, 12));

        const result = await executeResume(FILE_ID, h.deps, new AbortController().signal);

        expect(result).toEqual({ actualSize: total });
        expect(h.completions).toEqual([
            {
                parts: [
                    { PartNumber: 1, ETag: 'etag-pre-1' },
                    { PartNumber: 2, ETag: 'etag-pre-2' },
                    { PartNumber: 3, ETag: 'etag-pre-3' },
                ],
                actualSize: total,
            },
        ]);
        // No part was re-uploaded and no URL refresh was needed.
        expect(h.log.filter((e) => e.startsWith('uploadPart:'))).toEqual([]);
        expect(h.refreshCalls).toEqual([]);
        // Finalize ordering: completeUpload → store.destroy → state.clearUpload.
        expect(h.log.indexOf('completeUpload')).toBeLessThan(h.log.indexOf('destroy'));
        expect(h.log.indexOf('destroy')).toBeLessThan(h.log.indexOf('clearUpload'));
        expect(await h.state.getLease(FILE_ID)).toBeUndefined();
        expect(h.events[h.events.length - 1]).toEqual({ type: 'done', actualSize: total });
    });

    it('replay-complete: a completeUpload rejection leaves state intact and emits error', async () => {
        const h = makeHarness(urlsFor(1));
        h.deps.completeUpload = () => Promise.reject(new Error('network error'));
        await h.state.putLease(makeLease());
        await h.state.putEnvelope(makeEnvelope());
        await h.state.putCheckpoint(eofCheckpoint(2));
        await h.state.putPart(uploadedPart(1, 12));

        await expect(executeResume(FILE_ID, h.deps, new AbortController().signal)).rejects.toThrow(
            'network error',
        );

        expect(await h.state.getLease(FILE_ID)).toBeDefined();
        expect(await h.state.getParts(FILE_ID)).toHaveLength(1);
        expect(h.log).not.toContain('destroy');
        expect(h.log).not.toContain('clearUpload');
        expect(h.events[h.events.length - 1]).toEqual({
            type: 'error',
            message: expect.stringContaining('network error'),
            retryable: true,
        });
    });

    it('finish-staged: uploads only the staged remainder and completes', async () => {
        const total = 2 * MIN + 12;
        const data2 = makeData(MIN, 7);
        const data3 = makeData(12, 3);
        const h = makeHarness(urlsFor(3));
        await h.state.putLease(makeLease());
        await h.state.putEnvelope(makeEnvelope({ expectedSize: total }));
        await h.state.putCheckpoint(eofCheckpoint(4, { sourceOffset: total }));
        await h.state.putPart(uploadedPart(1, MIN));
        await h.state.putPart(stagedPart(2, MIN));
        await h.state.putPart(stagedPart(3, 12));
        await h.store.stagePart(2, chunksOf(data2));
        await h.store.stagePart(3, chunksOf(data3));

        const result = await executeResume(FILE_ID, h.deps, new AbortController().signal);

        expect(result).toEqual({ actualSize: total });
        // Fresh pre-signed URLs were fetched with the lease's uploadToken.
        expect(h.refreshCalls).toEqual([{ fileId: FILE_ID, uploadToken: 'tok-1' }]);
        // Only the staged remainder was uploaded, byte-identically.
        expect(h.log.filter((e) => e.startsWith('uploadPart:'))).toEqual([
            'uploadPart:2',
            'uploadPart:3',
        ]);
        expect(bytesEqual(h.bodies.get(2), data2)).toBe(true);
        expect(bytesEqual(h.bodies.get(3), data3)).toBe(true);
        // Completion combines the persisted ETag with the fresh ones.
        expect(h.completions).toEqual([
            {
                parts: [
                    { PartNumber: 1, ETag: 'etag-pre-1' },
                    { PartNumber: 2, ETag: 'etag-2' },
                    { PartNumber: 3, ETag: 'etag-3' },
                ],
                actualSize: total,
            },
        ]);
        expect(await h.state.getLease(FILE_ID)).toBeUndefined();
        expect(h.events[h.events.length - 1]).toEqual({ type: 'done', actualSize: total });
    });

    it('need-source: rejects with the source kind and completes nothing', async () => {
        const h = makeHarness(urlsFor(2));
        await h.state.putLease(makeLease());
        await h.state.putEnvelope(makeEnvelope({ manifest: MULTI_MANIFEST }));
        await h.state.putCheckpoint(midCheckpoint(2));
        await h.state.putPart(stagedPart(1, 6));

        const run = executeResume(FILE_ID, h.deps, new AbortController().signal);
        await expect(run).rejects.toBeInstanceOf(ResumeNeedsSourceError);
        await expect(run).rejects.toMatchObject({ kind: 'multi' });
        expect(h.completions).toEqual([]);
        expect(h.log).not.toContain('destroy');
        expect(h.events[h.events.length - 1]).toMatchObject({ type: 'error', retryable: false });
    });

    it('unrecoverable: rejects when no engine state exists', async () => {
        const h = makeHarness(urlsFor(1));

        await expect(executeResume(FILE_ID, h.deps, new AbortController().signal)).rejects.toThrow(
            /not resumable/,
        );
        expect(h.completions).toEqual([]);
        expect(h.events[h.events.length - 1]).toMatchObject({ type: 'error', retryable: false });
    });
});
