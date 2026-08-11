import { afterEach, describe, expect, it } from 'vitest';
import { MemoryPartStore, OpfsPartStore, PartStoreQuotaError, UPLOADS_DIR } from '../part-store';

// biome-ignore lint/suspicious/useAwait: async generator builds the AsyncIterable the PartStore contract requires
async function* chunks(...arrays: Uint8Array[]) {
    for (const a of arrays) {
        yield a;
    }
}

describe('MemoryPartStore', () => {
    it('stages, lists, reads, deletes a part', async () => {
        const s = new MemoryPartStore();
        const { size } = await s.stagePart(1, chunks(new Uint8Array([1, 2]), new Uint8Array([3])));
        expect(size).toBe(3);
        expect(await s.listParts()).toEqual([{ partNumber: 1, size: 3 }]);
        expect(new Uint8Array(await (await s.readPart(1)).arrayBuffer())).toEqual(
            new Uint8Array([1, 2, 3]),
        );
        await s.deletePart(1);
        expect(await s.listParts()).toEqual([]);
    });
    it('an aborted stage leaves no committed part', async () => {
        const s = new MemoryPartStore();
        // biome-ignore lint/suspicious/useAwait: async generator builds the AsyncIterable the PartStore contract requires
        async function* failing() {
            yield new Uint8Array([1]);
            throw new Error('source died');
        }
        await expect(s.stagePart(1, failing())).rejects.toThrow('source died');
        expect(await s.listParts()).toEqual([]);
    });
    it('throws typed quota error and stages nothing', async () => {
        const s = new MemoryPartStore({ quotaBytes: 2 });
        await expect(s.stagePart(1, chunks(new Uint8Array([1, 2, 3])))).rejects.toBeInstanceOf(
            PartStoreQuotaError,
        );
        expect(await s.listParts()).toEqual([]);
    });
    it('re-staging the same part number replaces it', async () => {
        const s = new MemoryPartStore();
        await s.stagePart(1, chunks(new Uint8Array([9])));
        await s.stagePart(1, chunks(new Uint8Array([7, 8])));
        expect(await s.listParts()).toEqual([{ partNumber: 1, size: 2 }]);
    });
});

// ---------------------------------------------------------------------------
// OpfsPartStore against an in-memory OPFS
//
// The worker-only surface (`createSyncAccessHandle`, `move`, directory
// iteration) exists in no test environment, so the store's real directory
// bookkeeping — which entries it opens, how often it walks to them, what it
// does when one disappears — is only reachable through a fake root.
// ---------------------------------------------------------------------------

function notFound(message: string): Error {
    const err = new Error(message);
    err.name = 'NotFoundError';
    return err;
}

class FakeFileEntry {
    data = new Uint8Array(0);

    constructor(
        private dir: FakeDirectory,
        public name: string,
    ) {}

    createSyncAccessHandle() {
        const entry = this;
        return Promise.resolve({
            write(buffer: Uint8Array, options?: { at?: number }): number {
                const at = options?.at ?? 0;
                if (at + buffer.byteLength > entry.data.byteLength) {
                    const grown = new Uint8Array(at + buffer.byteLength);
                    grown.set(entry.data);
                    entry.data = grown;
                }
                entry.data.set(buffer, at);
                return buffer.byteLength;
            },
            truncate(newSize: number): void {
                entry.data = entry.data.slice(0, newSize);
            },
            flush(): void {
                // writes land in `entry.data` immediately; nothing to flush
            },
            close(): void {
                // no OS resource behind this handle
            },
        });
    }

    getFile(): Promise<File> {
        return Promise.resolve(new File([this.data as BlobPart], this.name));
    }

    /**
     * WebKit's contract, which is the strict one: `FileSystemHandle.idl`
     * declares `move(FileSystemHandle destination, USVString newName)` with
     * no optionals and no overloads, so Chromium's one-argument rename
     * throws `TypeError: Not enough arguments` before moving anything —
     * synchronously, from the bindings' arity check. Chromium accepts this
     * two-argument form too, so modelling the stricter engine is the only
     * way the fake stays honest for both.
     */
    move(...args: [destination: FakeDirectory, newName: string]): Promise<void> {
        if (args.length < 2) {
            throw new TypeError('Not enough arguments');
        }
        const [destination, newName] = args;
        this.dir.entries.delete(this.name);
        this.name = newName;
        destination.entries.set(newName, this);
        this.dir = destination;
        return Promise.resolve();
    }
}

/** Saved so the move()-absent and move()-rejects cases can restore the default. */
const moveDescriptor = Object.getOwnPropertyDescriptor(
    FakeFileEntry.prototype,
    'move',
) as PropertyDescriptor;

/** A directory that can be removed out from under a handle still holding it. */
class FakeDirectory {
    readonly entries = new Map<string, FakeDirectory | FakeFileEntry>();
    private live = true;

    constructor(
        readonly name: string,
        private readonly counters: { getDirectory: number },
    ) {}

    kill(): void {
        this.live = false;
        for (const entry of this.entries.values()) {
            if (entry instanceof FakeDirectory) {
                entry.kill();
            }
        }
    }

    getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileEntry> {
        if (!this.live) {
            return Promise.reject(notFound(`directory ${this.name} was removed`));
        }
        const existing = this.entries.get(name);
        if (existing instanceof FakeFileEntry) {
            return Promise.resolve(existing);
        }
        if (!opts?.create) {
            return Promise.reject(notFound(`no file ${name}`));
        }
        const entry = new FakeFileEntry(this, name);
        this.entries.set(name, entry);
        return Promise.resolve(entry);
    }

    getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirectory> {
        if (!this.live) {
            return Promise.reject(notFound(`directory ${this.name} was removed`));
        }
        const existing = this.entries.get(name);
        if (existing instanceof FakeDirectory) {
            return Promise.resolve(existing);
        }
        if (!opts?.create) {
            return Promise.reject(notFound(`no directory ${name}`));
        }
        const dir = new FakeDirectory(name, this.counters);
        this.entries.set(name, dir);
        return Promise.resolve(dir);
    }

    removeEntry(name: string): Promise<void> {
        if (!this.live) {
            return Promise.reject(notFound(`directory ${this.name} was removed`));
        }
        const entry = this.entries.get(name);
        if (!entry) {
            return Promise.reject(notFound(`no entry ${name}`));
        }
        if (entry instanceof FakeDirectory) {
            entry.kill();
        }
        this.entries.delete(name);
        return Promise.resolve();
    }

    async *keys(): AsyncIterableIterator<string> {
        if (!this.live) {
            throw notFound(`directory ${this.name} was removed`);
        }
        yield* [...this.entries.keys()];
    }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');

function installFakeOpfs() {
    const counters = { getDirectory: 0 };
    const root = new FakeDirectory('', counters);
    Object.defineProperty(globalThis.navigator, 'storage', {
        configurable: true,
        writable: true,
        value: {
            getDirectory: () => {
                counters.getDirectory += 1;
                return Promise.resolve(root);
            },
        },
    });
    return { root, counters };
}

/** Remove `uploads/<fileId>` behind the store's back (teardown, GC, eviction). */
async function removeStagingDir(root: FakeDirectory, fileId: string): Promise<void> {
    const uploads = await root.getDirectoryHandle(UPLOADS_DIR);
    await uploads.removeEntry(fileId);
}

describe('OpfsPartStore', () => {
    afterEach(() => {
        if (originalStorage) {
            Object.defineProperty(globalThis.navigator, 'storage', originalStorage);
        } else {
            Reflect.deleteProperty(globalThis.navigator as object, 'storage');
        }
    });

    it('stages through a temp entry, commits by rename, then reads and deletes', async () => {
        const { root } = installFakeOpfs();
        const store = new OpfsPartStore('up_opfs');

        const { size } = await store.stagePart(
            1,
            chunks(new Uint8Array([1, 2]), new Uint8Array([3])),
        );

        expect(size).toBe(3);
        expect(await store.listParts()).toEqual([{ partNumber: 1, size: 3 }]);
        expect(new Uint8Array(await (await store.readPart(1)).arrayBuffer())).toEqual(
            new Uint8Array([1, 2, 3]),
        );
        // Only the committed name survives the rename.
        const uploads = await root.getDirectoryHandle(UPLOADS_DIR);
        const dir = await uploads.getDirectoryHandle('up_opfs');
        expect([...dir.entries.keys()]).toEqual(['part-1.bin']);

        await store.deletePart(1);
        expect(await store.listParts()).toEqual([]);
        await expect(store.readPart(1)).rejects.toThrow('part 1 is not committed');
    });

    it('commits by copying when the engine exposes no move()', async () => {
        const { root } = installFakeOpfs();
        Reflect.deleteProperty(FakeFileEntry.prototype as object, 'move');
        try {
            const store = new OpfsPartStore('up_nomove');
            const { size } = await store.stagePart(1, chunks(new Uint8Array([4, 5, 6])));

            expect(size).toBe(3);
            expect(new Uint8Array(await (await store.readPart(1)).arrayBuffer())).toEqual(
                new Uint8Array([4, 5, 6]),
            );
            const uploads = await root.getDirectoryHandle(UPLOADS_DIR);
            const dir = await uploads.getDirectoryHandle('up_nomove');
            expect([...dir.entries.keys()]).toEqual(['part-1.bin']);
        } finally {
            Object.defineProperty(FakeFileEntry.prototype, 'move', moveDescriptor);
        }
    });

    it('commits by copying when move() exists but rejects', async () => {
        const { root } = installFakeOpfs();
        Object.defineProperty(FakeFileEntry.prototype, 'move', {
            configurable: true,
            writable: true,
            // Any engine-specific rename fault — an arity mismatch like
            // WebKit's, or a cross-directory refusal — must degrade to the
            // copy path rather than failing the upload.
            value: () => {
                throw new TypeError('Not enough arguments');
            },
        });
        try {
            const store = new OpfsPartStore('up_badmove');
            const { size } = await store.stagePart(1, chunks(new Uint8Array([7, 8])));

            expect(size).toBe(2);
            expect(new Uint8Array(await (await store.readPart(1)).arrayBuffer())).toEqual(
                new Uint8Array([7, 8]),
            );
            const uploads = await root.getDirectoryHandle(UPLOADS_DIR);
            const dir = await uploads.getDirectoryHandle('up_badmove');
            expect([...dir.entries.keys()]).toEqual(['part-1.bin']);
        } finally {
            Object.defineProperty(FakeFileEntry.prototype, 'move', moveDescriptor);
        }
    });

    it('resolves the staging directory once for the store’s lifetime', async () => {
        const { counters } = installFakeOpfs();
        const store = new OpfsPartStore('up_opfs');

        await store.stagePart(1, chunks(new Uint8Array([1, 2, 3])));
        await store.stagePart(2, chunks(new Uint8Array([4, 5])));
        await store.readPart(1);
        await store.listParts();
        await store.deletePart(1);
        await store.readPart(2);

        // Six operations, one directory walk — the handle is memoized.
        expect(counters.getDirectory).toBe(1);
    });

    it('re-resolves once when its memoized directory was removed underneath it', async () => {
        const { root, counters } = installFakeOpfs();
        const store = new OpfsPartStore('up_opfs');
        await store.stagePart(1, chunks(new Uint8Array([1, 2, 3])));
        expect(counters.getDirectory).toBe(1);

        await removeStagingDir(root, 'up_opfs');

        // Staging re-resolves and writes every byte: the retry happens before
        // the chunk iterable is touched, so nothing is consumed twice.
        const { size } = await store.stagePart(2, chunks(new Uint8Array([7, 8, 9, 10])));
        expect(size).toBe(4);
        expect(counters.getDirectory).toBe(2);
        expect(new Uint8Array(await (await store.readPart(2)).arrayBuffer())).toEqual(
            new Uint8Array([7, 8, 9, 10]),
        );
    });

    it('reports an empty store when its directory is gone rather than throwing', async () => {
        const { root } = installFakeOpfs();
        const store = new OpfsPartStore('up_opfs');
        await store.stagePart(1, chunks(new Uint8Array([1, 2, 3])));

        await removeStagingDir(root, 'up_opfs');

        expect(await store.listParts()).toEqual([]);
        await expect(store.readPart(1)).rejects.toThrow('part 1 is not committed');
        // A detached delete arriving after teardown is a no-op, never a throw.
        await expect(store.deletePart(1)).resolves.toBeUndefined();
    });

    it('destroy removes the whole upload directory and drops the memoized handle', async () => {
        const { root, counters } = installFakeOpfs();
        const store = new OpfsPartStore('up_opfs');
        await store.stagePart(1, chunks(new Uint8Array([1, 2, 3])));

        await store.destroy();

        const uploads = await root.getDirectoryHandle(UPLOADS_DIR);
        expect([...uploads.entries.keys()]).toEqual([]);
        // The next stage rebuilds it from a fresh walk.
        await store.stagePart(1, chunks(new Uint8Array([4])));
        expect(counters.getDirectory).toBe(3); // stage, destroy, stage
        expect(await store.listParts()).toEqual([{ partNumber: 1, size: 1 }]);
    });
});
