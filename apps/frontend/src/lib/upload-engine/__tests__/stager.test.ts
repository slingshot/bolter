import { describe, expect, it } from 'vitest';
import {
    calculateEncryptedSize,
    createDecryptionStream,
    createEncryptionStream,
    ECE_ENCRYPTED_RECORD_SIZE,
    ECE_RECORD_SIZE,
    ECE_VERSION,
    Keychain,
} from '@/lib/crypto';
import { MemoryPartStore, type PartStore } from '../part-store';
import { createSliceProducer } from '../producer';
import { runStager } from '../stager';
import type {
    CompletionEnvelope,
    EngineLease,
    EnginePartRecord,
    EngineStateStore,
    ProducerCheckpoint,
} from '../state';

const TEN_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function makeData(size: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = i % 256;
    }
    return data;
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

async function readAllParts(store: PartStore): Promise<Uint8Array> {
    const parts = await store.listParts();
    const buffers: Uint8Array[] = [];
    for (const part of parts) {
        buffers.push(new Uint8Array(await (await store.readPart(part.partNumber)).arrayBuffer()));
    }
    return concat(buffers);
}

async function pipeBytes(
    data: Uint8Array,
    stream: TransformStream<Uint8Array, Uint8Array>,
): Promise<Uint8Array> {
    const writer = stream.writable.getWriter();
    const writePromise = (async () => {
        await writer.write(data);
        await writer.close();
    })();
    writePromise.catch(() => undefined);
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    await writePromise;
    return concat(chunks);
}

async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (cond()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('condition not reached');
}

/** Fake `EngineStateStore` backed by Maps, recording put order into `log`. */
function fakeState(log: string[] = []) {
    const leases = new Map<string, EngineLease>();
    const envelopes = new Map<string, CompletionEnvelope>();
    const checkpoints = new Map<string, ProducerCheckpoint>();
    const parts = new Map<string, EnginePartRecord>();
    const partPuts: EnginePartRecord[] = [];
    const checkpointPuts: ProducerCheckpoint[] = [];
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
            log.push(`putCheckpoint:${c.nextPartNumber}`);
            checkpointPuts.push({ ...c });
            checkpoints.set(c.fileId, c);
            return Promise.resolve();
        },
        getCheckpoint(fileId) {
            return Promise.resolve(checkpoints.get(fileId));
        },
        putPart(p) {
            log.push(`putPart:${p.partNumber}`);
            partPuts.push({ ...p });
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
    return { state, partPuts, checkpointPuts, log };
}

/** `PartStore` wrapper recording call order into `log`. */
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
        return this.inner.deletePart(partNumber);
    }

    listParts(): Promise<{ partNumber: number; size: number }[]> {
        return this.inner.listParts();
    }

    destroy(): Promise<void> {
        return this.inner.destroy();
    }
}

function checkpointOf(fileId: string) {
    return (sourceOffset: number, partNumber: number, eof: boolean): ProducerCheckpoint => ({
        fileId,
        nextPartNumber: partNumber,
        sourceOffset,
        eceCounter: 0,
        eofReached: eof,
        finalRecordEmitted: eof,
    });
}

const neverReleased = () => Promise.reject(new Error('partReleased should not be needed'));

describe('runStager', () => {
    it('cuts exact part boundaries with a durable checkpoint after each stage', async () => {
        const log: string[] = [];
        const store = new RecordingPartStore(new MemoryPartStore(), log);
        const { state, partPuts, checkpointPuts } = fakeState(log);

        const result = await runStager(
            createSliceProducer(new Blob([TEN_BYTES]), { chunkBytes: 3 }),
            {
                fileId: 'up_ten',
                partSize: 4,
                totalParts: 3,
                windowSize: 8,
                store,
                state,
                checkpointOf: checkpointOf('up_ten'),
                onPartStaged: (partNumber) => {
                    log.push(`staged:${partNumber}`);
                },
                partReleased: neverReleased,
            },
        );

        expect(result).toEqual({ partsProduced: 3, actualSize: 10 });
        expect(await store.listParts()).toEqual([
            { partNumber: 1, size: 4 },
            { partNumber: 2, size: 4 },
            { partNumber: 3, size: 2 },
        ]);
        expect(await readAllParts(store)).toEqual(TEN_BYTES);
        expect(partPuts).toEqual([
            { fileId: 'up_ten', partNumber: 1, size: 4, staged: true, uploaded: false },
            { fileId: 'up_ten', partNumber: 2, size: 4, staged: true, uploaded: false },
            { fileId: 'up_ten', partNumber: 3, size: 2, staged: true, uploaded: false },
        ]);
        expect(checkpointPuts.map((c) => c.nextPartNumber)).toEqual([2, 3, 4]);
        expect(checkpointPuts.map((c) => c.sourceOffset)).toEqual([4, 8, 10]);
        expect(checkpointPuts.map((c) => c.eofReached)).toEqual([false, false, true]);
        // putPart precedes putCheckpoint for every part; staging notifications follow both.
        expect(log).toEqual([
            'stagePart:1',
            'putPart:1',
            'putCheckpoint:2',
            'staged:1',
            'stagePart:2',
            'putPart:2',
            'putCheckpoint:3',
            'staged:2',
            'stagePart:3',
            'putPart:3',
            'putCheckpoint:4',
            'staged:3',
        ]);
    });

    it('absorbs growth into the final allocated part', async () => {
        const twelve = makeData(12);
        const store = new MemoryPartStore();
        const { state, checkpointPuts } = fakeState();

        const result = await runStager(createSliceProducer(new Blob([twelve]), { chunkBytes: 5 }), {
            fileId: 'up_grow',
            partSize: 4,
            totalParts: 2,
            windowSize: 8,
            store,
            state,
            checkpointOf: checkpointOf('up_grow'),
            onPartStaged: () => undefined,
            partReleased: neverReleased,
        });

        expect(result).toEqual({ partsProduced: 2, actualSize: 12 });
        expect(await store.listParts()).toEqual([
            { partNumber: 1, size: 4 },
            { partNumber: 2, size: 8 },
        ]);
        expect(await readAllParts(store)).toEqual(twelve);
        expect(checkpointPuts.map((c) => c.nextPartNumber)).toEqual([2, 3]);
        expect(checkpointPuts.map((c) => c.sourceOffset)).toEqual([4, 12]);
        expect(checkpointPuts.map((c) => c.eofReached)).toEqual([false, true]);
    });

    it('produces fewer parts for a short source, marking eof at an exact boundary', async () => {
        const eight = makeData(8);
        const store = new MemoryPartStore();
        const { state, checkpointPuts } = fakeState();

        const result = await runStager(createSliceProducer(new Blob([eight]), { chunkBytes: 3 }), {
            fileId: 'up_shrink',
            partSize: 4,
            totalParts: 3,
            windowSize: 8,
            store,
            state,
            checkpointOf: checkpointOf('up_shrink'),
            onPartStaged: () => undefined,
            partReleased: neverReleased,
        });

        expect(result).toEqual({ partsProduced: 2, actualSize: 8 });
        expect(await store.listParts()).toEqual([
            { partNumber: 1, size: 4 },
            { partNumber: 2, size: 4 },
        ]);
        expect(checkpointPuts.map((c) => c.nextPartNumber)).toEqual([2, 3]);
        expect(checkpointPuts.map((c) => c.eofReached)).toEqual([false, true]);
    });

    it('stages nothing for an empty source', async () => {
        const log: string[] = [];
        const store = new RecordingPartStore(new MemoryPartStore(), log);
        const { state, checkpointPuts } = fakeState(log);

        const result = await runStager(createSliceProducer(new Blob([]), { chunkBytes: 4 }), {
            fileId: 'up_empty',
            partSize: 4,
            totalParts: 2,
            windowSize: 8,
            store,
            state,
            checkpointOf: checkpointOf('up_empty'),
            onPartStaged: () => undefined,
            partReleased: neverReleased,
        });

        expect(result).toEqual({ partsProduced: 0, actualSize: 0 });
        expect(log).toEqual([]);
        expect(checkpointPuts).toEqual([]);
    });

    it('applies window backpressure: part 2 stages only after a slot frees', async () => {
        const log: string[] = [];
        const store = new RecordingPartStore(new MemoryPartStore(), log);
        const { state } = fakeState(log);
        const releases: (() => void)[] = [];
        const partReleased = () =>
            new Promise<void>((resolve) => {
                log.push('await-release');
                releases.push(resolve);
            });

        const run = runStager(createSliceProducer(new Blob([makeData(8)]), { chunkBytes: 3 }), {
            fileId: 'up_window',
            partSize: 4,
            totalParts: 2,
            windowSize: 1,
            store,
            state,
            checkpointOf: checkpointOf('up_window'),
            onPartStaged: () => undefined,
            partReleased,
        });

        await waitFor(() => releases.length === 1);
        // Part 1 staged; part 2 must not have begun while the window is full.
        expect(log.filter((e) => e.startsWith('stagePart'))).toEqual(['stagePart:1']);

        releases[0]();
        const result = await run;
        expect(result).toEqual({ partsProduced: 2, actualSize: 8 });
        expect(log.filter((e) => e.startsWith('stagePart'))).toEqual([
            'stagePart:1',
            'stagePart:2',
        ]);
        expect(log.indexOf('stagePart:2')).toBeGreaterThan(log.indexOf('await-release'));
    });

    it('cuts encrypted output at exact record boundaries, staging ciphertext only', async () => {
        const keychain = new Keychain();
        const plaintext = makeData(2 * ECE_RECORD_SIZE + 1000);
        const store = new MemoryPartStore();
        const { state, checkpointPuts } = fakeState();

        const result = await runStager(
            createSliceProducer(new Blob([plaintext]), { chunkBytes: 60_000 }),
            {
                fileId: 'up_enc',
                partSize: ECE_ENCRYPTED_RECORD_SIZE,
                totalParts: 3,
                windowSize: 8,
                store,
                state,
                encrypt: createEncryptionStream(keychain),
                checkpointOf: checkpointOf('up_enc'),
                onPartStaged: () => undefined,
                partReleased: neverReleased,
            },
        );

        const expectedTotal = calculateEncryptedSize(plaintext.byteLength);
        expect(result).toEqual({ partsProduced: 3, actualSize: expectedTotal });
        const parts = await store.listParts();
        expect(parts.map((p) => p.size)).toEqual([
            ECE_ENCRYPTED_RECORD_SIZE,
            ECE_ENCRYPTED_RECORD_SIZE,
            expectedTotal - 2 * ECE_ENCRYPTED_RECORD_SIZE,
        ]);

        // Staged bytes are ciphertext, not plaintext.
        const part1 = new Uint8Array(await (await store.readPart(1)).arrayBuffer());
        expect(part1).not.toEqual(plaintext.slice(0, ECE_ENCRYPTED_RECORD_SIZE));

        // Checkpoint offsets are plaintext-domain record boundaries.
        expect(checkpointPuts.map((c) => c.sourceOffset)).toEqual([
            ECE_RECORD_SIZE,
            2 * ECE_RECORD_SIZE,
            plaintext.byteLength,
        ]);
        expect(checkpointPuts.map((c) => c.eofReached)).toEqual([false, false, true]);

        // The concatenated staged parts decrypt back to the plaintext.
        const decrypted = await pipeBytes(
            await readAllParts(store),
            createDecryptionStream(keychain, { eceVersion: ECE_VERSION }),
        );
        expect(decrypted).toEqual(plaintext);
    });
});
