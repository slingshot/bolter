import { beforeEach, describe, expect, it } from 'vitest';
import type {
    CompletionEnvelope,
    EngineLease,
    EnginePartRecord,
    ProducerCheckpoint,
} from '../state';
import { openEngineState } from '../state';

function makeLease(overrides: Partial<EngineLease> = {}): EngineLease {
    return {
        fileId: 'file-a',
        uploadId: 'upload-a',
        uploadToken: 'token-a',
        ownerToken: 'owner-a',
        createdAt: 1_700_000_000_000,
        engineVersion: 1,
        ...overrides,
    };
}

function makeEnvelope(overrides: Partial<CompletionEnvelope> = {}): CompletionEnvelope {
    return {
        fileId: 'file-a',
        metadata: 'exact-encrypted-metadata-payload',
        authKeyB64: 'auth-key-b64',
        manifest: [
            { name: 'a.bin', size: 10, type: 'application/octet-stream' },
            { name: 'b.txt', size: 3, type: 'text/plain' },
        ],
        zipFilename: 'bolter-archive.zip',
        expectedSize: 13,
        encrypted: true,
        secretKeyB64: 'secret-key-b64',
        timeLimit: 86_400,
        downloadLimit: 5,
        ...overrides,
    };
}

function makeCheckpoint(overrides: Partial<ProducerCheckpoint> = {}): ProducerCheckpoint {
    return {
        fileId: 'file-a',
        nextPartNumber: 2,
        sourceOffset: 5_242_880,
        eceCounter: 80,
        eofReached: false,
        finalRecordEmitted: false,
        ...overrides,
    };
}

function makePart(overrides: Partial<EnginePartRecord> = {}): EnginePartRecord {
    return {
        fileId: 'file-a',
        partNumber: 1,
        size: 5_242_880,
        staged: true,
        uploaded: false,
        ...overrides,
    };
}

describe('engine state store (bolter-upload-engine)', () => {
    beforeEach(async () => {
        // Delete the engine database to ensure a clean state between tests
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase('bolter-upload-engine');
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => resolve(); // proceed even if blocked
        });
    });

    it('round-trips a lease', async () => {
        const state = await openEngineState();
        const lease = makeLease();

        await state.putLease(lease);

        expect(await state.getLease('file-a')).toEqual(lease);
        expect(await state.getLease('missing')).toBeUndefined();
    });

    it('round-trips an envelope preserving every field', async () => {
        const state = await openEngineState();
        const envelope = makeEnvelope();

        await state.putEnvelope(envelope);

        expect(await state.getEnvelope('file-a')).toEqual(envelope);
        expect(await state.getEnvelope('missing')).toBeUndefined();
    });

    it('overwrites a checkpoint: get returns the latest put', async () => {
        const state = await openEngineState();

        await state.putCheckpoint(makeCheckpoint());
        const latest = makeCheckpoint({
            nextPartNumber: 4,
            sourceOffset: 15_728_640,
            eceCounter: 240,
            eofReached: true,
            finalRecordEmitted: true,
        });
        await state.putCheckpoint(latest);

        expect(await state.getCheckpoint('file-a')).toEqual(latest);
        expect(await state.getCheckpoint('missing')).toBeUndefined();
    });

    it('returns parts sorted by partNumber, isolated per fileId', async () => {
        const state = await openEngineState();

        // Insert out of order for file-a, plus a record under another fileId
        await state.putPart(makePart({ partNumber: 3 }));
        await state.putPart(makePart({ partNumber: 1 }));
        await state.putPart(makePart({ partNumber: 2, size: 1024 }));
        await state.putPart(makePart({ fileId: 'file-b', partNumber: 1, size: 99 }));

        const partsA = await state.getParts('file-a');
        expect(partsA.map((p) => p.partNumber)).toEqual([1, 2, 3]);
        expect(partsA).toEqual([
            makePart({ partNumber: 1 }),
            makePart({ partNumber: 2, size: 1024 }),
            makePart({ partNumber: 3 }),
        ]);

        expect(await state.getParts('file-b')).toEqual([
            makePart({ fileId: 'file-b', partNumber: 1, size: 99 }),
        ]);
        expect(await state.getParts('missing')).toEqual([]);
    });

    it('replaces a part record on re-put of the same compound key', async () => {
        const state = await openEngineState();

        await state.putPart(makePart({ partNumber: 1 }));
        const uploaded = makePart({ partNumber: 1, uploaded: true, etag: '"etag-1"' });
        await state.putPart(uploaded);

        expect(await state.getParts('file-a')).toEqual([uploaded]);
    });

    it('lists all leases', async () => {
        const state = await openEngineState();
        const leaseA = makeLease({ fileId: 'file-a' });
        const leaseB = makeLease({
            fileId: 'file-b',
            uploadId: 'upload-b',
            uploadToken: undefined,
        });

        await state.putLease(leaseA);
        await state.putLease(leaseB);

        const leases = await state.listLeases();
        expect(leases).toHaveLength(2);
        expect(leases.sort((a, b) => a.fileId.localeCompare(b.fileId))).toEqual([leaseA, leaseB]);
    });

    it('clearUpload removes all four record types for one fileId and leaves others intact', async () => {
        const state = await openEngineState();

        for (const fileId of ['file-a', 'file-b']) {
            await state.putLease(makeLease({ fileId }));
            await state.putEnvelope(makeEnvelope({ fileId }));
            await state.putCheckpoint(makeCheckpoint({ fileId }));
            await state.putPart(makePart({ fileId, partNumber: 1 }));
            await state.putPart(makePart({ fileId, partNumber: 2 }));
        }

        await state.clearUpload('file-a');

        expect(await state.getLease('file-a')).toBeUndefined();
        expect(await state.getEnvelope('file-a')).toBeUndefined();
        expect(await state.getCheckpoint('file-a')).toBeUndefined();
        expect(await state.getParts('file-a')).toEqual([]);

        expect(await state.getLease('file-b')).toEqual(makeLease({ fileId: 'file-b' }));
        expect(await state.getEnvelope('file-b')).toEqual(makeEnvelope({ fileId: 'file-b' }));
        expect(await state.getCheckpoint('file-b')).toEqual(makeCheckpoint({ fileId: 'file-b' }));
        expect(await state.getParts('file-b')).toEqual([
            makePart({ fileId: 'file-b', partNumber: 1 }),
            makePart({ fileId: 'file-b', partNumber: 2 }),
        ]);

        expect(await state.listLeases()).toEqual([makeLease({ fileId: 'file-b' })]);
    });

    it('clearUpload of an unknown fileId is a no-op', async () => {
        const state = await openEngineState();
        await state.putLease(makeLease());

        await expect(state.clearUpload('nonexistent')).resolves.toBeUndefined();

        expect(await state.getLease('file-a')).toEqual(makeLease());
    });
});
