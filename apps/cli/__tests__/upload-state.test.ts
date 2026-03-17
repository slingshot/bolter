import { afterEach, describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PersistedUpload } from '../lib/upload-state';
import * as uploadState from '../lib/upload-state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UPLOADS_DIR = join(homedir(), '.bolter', 'uploads');

/** Generate a unique file ID for test isolation. */
function uniqueId(): string {
    return `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Track created file IDs for cleanup. */
const createdIds: string[] = [];

function makeState(overrides?: Partial<PersistedUpload>): PersistedUpload {
    const fileId = overrides?.fileId ?? uniqueId();
    createdIds.push(fileId);
    return {
        fileId,
        uploadId: 'upload-123',
        ownerToken: 'owner-abc',
        fileName: 'test-file.bin',
        fileSize: 1024 * 1024,
        fileMtime: Date.now(),
        encrypted: false,
        partSize: 200 * 1024 * 1024,
        plaintextPartSize: 200 * 1024 * 1024,
        completedParts: [],
        totalParts: 5,
        timeLimit: 86400,
        downloadLimit: 1,
        createdAt: Date.now(),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(async () => {
    // Remove all state files created during the test
    for (const id of createdIds) {
        try {
            await unlink(join(UPLOADS_DIR, `${id}.json`));
        } catch {
            // File may already be removed by the test
        }
    }
    createdIds.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CRUD operations', () => {
    test('save() + load() roundtrip: saved state matches loaded state', async () => {
        const state = makeState();
        await uploadState.save(state);
        const loaded = await uploadState.load(state.fileId);
        expect(loaded).toEqual(state);
    });

    test('load() returns null for non-existent ID', async () => {
        const loaded = await uploadState.load('nonexistent-id-that-does-not-exist');
        expect(loaded).toBeNull();
    });

    test('remove() deletes the state file', async () => {
        const state = makeState();
        await uploadState.save(state);
        await uploadState.remove(state.fileId);
        const loaded = await uploadState.load(state.fileId);
        expect(loaded).toBeNull();
    });

    test("remove() on non-existent ID doesn't throw", async () => {
        // Should not throw
        await expect(uploadState.remove('nonexistent-id-xyz')).resolves.toBeUndefined();
    });

    test('save() overwrites existing state', async () => {
        const state = makeState();
        await uploadState.save(state);

        const updated = { ...state, fileName: 'updated-file.bin' };
        await uploadState.save(updated);

        const loaded = await uploadState.load(state.fileId);
        expect(loaded?.fileName).toBe('updated-file.bin');
    });

    test('save() preserves all fields including optional secretKeyB64', async () => {
        const state = makeState({ secretKeyB64: 'dGVzdC1rZXk', encrypted: true });
        await uploadState.save(state);
        const loaded = await uploadState.load(state.fileId);
        expect(loaded?.secretKeyB64).toBe('dGVzdC1rZXk');
        expect(loaded?.encrypted).toBe(true);
    });
});

describe('Part updates', () => {
    test('updatePart() adds a part', async () => {
        const state = makeState();
        await uploadState.save(state);

        await uploadState.updatePart(state.fileId, { PartNumber: 1, ETag: '"etag-1"' });

        const loaded = await uploadState.load(state.fileId);
        expect(loaded?.completedParts).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }]);
    });

    test('updatePart() deduplicates by PartNumber', async () => {
        const state = makeState();
        await uploadState.save(state);

        await uploadState.updatePart(state.fileId, { PartNumber: 1, ETag: '"etag-old"' });
        await uploadState.updatePart(state.fileId, { PartNumber: 1, ETag: '"etag-new"' });

        const loaded = await uploadState.load(state.fileId);
        expect(loaded?.completedParts).toHaveLength(1);
        expect(loaded?.completedParts[0].ETag).toBe('"etag-new"');
    });

    test('updatePart() keeps parts sorted by PartNumber', async () => {
        const state = makeState();
        await uploadState.save(state);

        await uploadState.updatePart(state.fileId, { PartNumber: 3, ETag: '"etag-3"' });
        await uploadState.updatePart(state.fileId, { PartNumber: 1, ETag: '"etag-1"' });
        await uploadState.updatePart(state.fileId, { PartNumber: 2, ETag: '"etag-2"' });

        const loaded = await uploadState.load(state.fileId);
        expect(loaded?.completedParts.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
    });

    test("multiple concurrent updatePart() calls don't lose data", async () => {
        const state = makeState();
        await uploadState.save(state);

        // Fire 10 concurrent updatePart calls
        const promises = Array.from({ length: 10 }, (_, i) =>
            uploadState.updatePart(state.fileId, { PartNumber: i + 1, ETag: `"etag-${i + 1}"` }),
        );
        await Promise.all(promises);

        const loaded = await uploadState.load(state.fileId);
        expect(loaded?.completedParts).toHaveLength(10);
        // Verify all parts are present and sorted
        for (let i = 0; i < 10; i++) {
            expect(loaded?.completedParts[i]).toEqual({
                PartNumber: i + 1,
                ETag: `"etag-${i + 1}"`,
            });
        }
    });

    test('updatePart() on non-existent state is a no-op', async () => {
        // Should not throw or create a file
        await uploadState.updatePart('nonexistent-update-test', {
            PartNumber: 1,
            ETag: '"etag"',
        });
        const loaded = await uploadState.load('nonexistent-update-test');
        expect(loaded).toBeNull();
    });
});

describe('Resume detection', () => {
    test('findResumable() finds matching state by name+size+mtime', async () => {
        const mtime = Date.now() - 1000;
        const state = makeState({
            fileName: 'resume-find.bin',
            fileSize: 5000,
            fileMtime: mtime,
        });
        await uploadState.save(state);

        const found = await uploadState.findResumable('resume-find.bin', 5000, mtime);
        expect(found).not.toBeNull();
        expect(found?.fileId).toBe(state.fileId);
    });

    test('findResumable() returns null when no match', async () => {
        const found = await uploadState.findResumable('no-such-file.bin', 9999, 0);
        expect(found).toBeNull();
    });

    test('findResumable() returns most recent when multiple matches', async () => {
        const mtime = 1000000;
        const older = makeState({
            fileName: 'multi-match.bin',
            fileSize: 2000,
            fileMtime: mtime,
            createdAt: Date.now() - 10000,
        });
        const newer = makeState({
            fileName: 'multi-match.bin',
            fileSize: 2000,
            fileMtime: mtime,
            createdAt: Date.now(),
        });
        await uploadState.save(older);
        await uploadState.save(newer);

        const found = await uploadState.findResumable('multi-match.bin', 2000, mtime);
        expect(found?.fileId).toBe(newer.fileId);
    });

    test("findResumable() doesn't match different sizes", async () => {
        const mtime = Date.now();
        const state = makeState({
            fileName: 'size-mismatch.bin',
            fileSize: 1000,
            fileMtime: mtime,
        });
        await uploadState.save(state);

        const found = await uploadState.findResumable('size-mismatch.bin', 9999, mtime);
        expect(found).toBeNull();
    });

    test("findResumable() doesn't match different mtimes", async () => {
        const state = makeState({
            fileName: 'mtime-mismatch.bin',
            fileSize: 1000,
            fileMtime: 111111,
        });
        await uploadState.save(state);

        const found = await uploadState.findResumable('mtime-mismatch.bin', 1000, 999999);
        expect(found).toBeNull();
    });

    test("findResumable() doesn't match different file names", async () => {
        const mtime = Date.now();
        const state = makeState({
            fileName: 'original-name.bin',
            fileSize: 1000,
            fileMtime: mtime,
        });
        await uploadState.save(state);

        const found = await uploadState.findResumable('different-name.bin', 1000, mtime);
        expect(found).toBeNull();
    });
});

describe('Cleanup', () => {
    test('cleanupExpired() removes states older than 7 days', async () => {
        const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
        const oldState = makeState({ createdAt: sevenDaysAgo });
        await uploadState.save(oldState);

        await uploadState.cleanupExpired();

        const loaded = await uploadState.load(oldState.fileId);
        expect(loaded).toBeNull();
    });

    test('cleanupExpired() keeps recent states', async () => {
        const recentState = makeState({ createdAt: Date.now() });
        await uploadState.save(recentState);

        await uploadState.cleanupExpired();

        const loaded = await uploadState.load(recentState.fileId);
        expect(loaded).not.toBeNull();
        expect(loaded?.fileId).toBe(recentState.fileId);
    });

    test('cleanupExpired() removes expired but keeps recent in same run', async () => {
        const oldState = makeState({ createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
        const newState = makeState({ createdAt: Date.now() });
        await uploadState.save(oldState);
        await uploadState.save(newState);

        await uploadState.cleanupExpired();

        const loadedOld = await uploadState.load(oldState.fileId);
        const loadedNew = await uploadState.load(newState.fileId);
        expect(loadedOld).toBeNull();
        expect(loadedNew).not.toBeNull();
    });
});
