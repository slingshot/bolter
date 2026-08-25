import { describe, expect, it } from 'vitest';
import { finalizeUpload } from '../completion';
import type { PartStore } from '../part-store';
import type { CompletionEnvelope, EngineStateStore } from '../state';

/** A legal effective part size: exactly the S3/R2 5 MiB minimum. */
const EFFECTIVE = 5_242_880;

const envelope: CompletionEnvelope = {
    fileId: 'up_test',
    metadata: 'encrypted-metadata-b64',
    authKeyB64: 'auth-key-b64',
    manifest: [{ name: 'a.bin', size: EFFECTIVE + 100, type: 'application/octet-stream' }],
    expectedSize: EFFECTIVE + 100,
    encrypted: false,
    timeLimit: 86400,
    downloadLimit: 10,
};

function fakeStore(log: string[]): PartStore {
    return {
        stagePart: () => Promise.reject(new Error('not used in finalization')),
        readPart: () => Promise.reject(new Error('not used in finalization')),
        deletePart: () => Promise.resolve(),
        listParts: () => Promise.resolve([]),
        destroy: () => {
            log.push('destroy');
            return Promise.resolve();
        },
    };
}

function fakeState(log: string[]): EngineStateStore {
    return {
        putLease: () => Promise.resolve(),
        getLease: () => Promise.resolve(undefined),
        putEnvelope: () => Promise.resolve(),
        getEnvelope: () => Promise.resolve(undefined),
        putCheckpoint: () => Promise.resolve(),
        getCheckpoint: () => Promise.resolve(undefined),
        putPart: () => Promise.resolve(),
        putPartAndCheckpoint: () => Promise.resolve(),
        getParts: () => Promise.resolve([]),
        listLeases: () => Promise.resolve([]),
        clearUpload: (fileId) => {
            log.push(`clearUpload:${fileId}`);
            return Promise.resolve();
        },
    };
}

function fakeDeps(opts?: { completeError?: Error }) {
    const log: string[] = [];
    const completeCalls: {
        envelope: CompletionEnvelope;
        parts: { PartNumber: number; ETag: string }[];
        actualSize: number;
    }[] = [];
    const deps = {
        store: fakeStore(log),
        state: fakeState(log),
        completeUpload: (
            e: CompletionEnvelope,
            parts: { PartNumber: number; ETag: string }[],
            actualSize: number,
        ) => {
            log.push('completeUpload');
            completeCalls.push({ envelope: e, parts, actualSize });
            return opts?.completeError ? Promise.reject(opts.completeError) : Promise.resolve();
        },
    };
    return { deps, log, completeCalls };
}
describe('finalizeUpload', () => {
    const etagsFor = (entries: [number, string][]) => new Map<number, string>(entries);
    const sizesFor = (entries: [number, number][]) => new Map<number, number>(entries);

    it('calls completeUpload, then store.destroy, then state.clearUpload — in order', async () => {
        const { deps, log, completeCalls } = fakeDeps();
        await finalizeUpload(
            envelope,
            etagsFor([
                [1, 'etag-1'],
                [2, 'etag-2'],
            ]),
            sizesFor([
                [1, EFFECTIVE],
                [2, 100],
            ]),
            EFFECTIVE,
            deps,
        );
        expect(log).toEqual(['completeUpload', 'destroy', 'clearUpload:up_test']);
        expect(completeCalls).toHaveLength(1);
        expect(completeCalls[0].envelope).toBe(envelope);
        expect(completeCalls[0].parts).toEqual([
            { PartNumber: 1, ETag: 'etag-1' },
            { PartNumber: 2, ETag: 'etag-2' },
        ]);
        expect(completeCalls[0].actualSize).toBe(EFFECTIVE + 100);
    });

    it('a completeUpload rejection leaves store and state intact', async () => {
        const { deps, log } = fakeDeps({ completeError: new Error('complete failed') });
        await expect(
            finalizeUpload(
                envelope,
                etagsFor([[1, 'etag-1']]),
                sizesFor([[1, 100]]),
                EFFECTIVE,
                deps,
            ),
        ).rejects.toThrow('complete failed');
        expect(log).toEqual(['completeUpload']);
    });

    it('rejects an invalid sequence before calling completeUpload', async () => {
        const { deps, log } = fakeDeps();
        await expect(
            finalizeUpload(
                envelope,
                etagsFor([
                    [1, 'etag-1'],
                    [3, 'etag-3'],
                ]),
                sizesFor([
                    [1, EFFECTIVE],
                    [3, 10],
                ]),
                EFFECTIVE,
                deps,
            ),
        ).rejects.toThrow(/^part sequence invalid/);
        expect(log).toEqual([]);
    });

    it('rejects when a part has no ETag, before calling completeUpload', async () => {
        const { deps, log } = fakeDeps();
        await expect(
            finalizeUpload(
                envelope,
                etagsFor([[1, 'etag-1']]),
                sizesFor([
                    [1, EFFECTIVE],
                    [2, 10],
                ]),
                EFFECTIVE,
                deps,
            ),
        ).rejects.toThrow(/^part sequence invalid/);
        expect(log).toEqual([]);
    });
});
