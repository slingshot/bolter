/**
 * Staged-part store for the worker upload engine.
 *
 * Parts are staged (fully materialized) before upload so retries are
 * byte-identical and part sizes are exact before any PUT. Staging is
 * two-phase: bytes are written to a temp entry (`part-<n>.tmp`), verified,
 * then committed by rename to `part-<n>.bin`. Only committed parts are
 * visible via `listParts`/`readPart`; a throw mid-stage leaves no committed
 * part behind.
 *
 * Worker-safe: no DOM globals, no top-level OPFS access — `OpfsPartStore`
 * feature-detects `navigator.storage.getDirectory` at call time so this
 * module stays importable under happy-dom.
 */

export class PartStoreQuotaError extends Error {} // thrown on quota exhaustion; retryable

export interface PartStore {
    stagePart(partNumber: number, chunks: AsyncIterable<Uint8Array>): Promise<{ size: number }>;
    readPart(partNumber: number): Promise<Blob>;
    deletePart(partNumber: number): Promise<void>;
    listParts(): Promise<{ partNumber: number; size: number }[]>; // committed parts only
    destroy(): Promise<void>;
}

/**
 * In-memory `PartStore` used by unit tests (and as a last-resort fallback).
 * Mirrors the OPFS store's semantics: staging bytes count against quota
 * alongside committed bytes (a temp file coexists with a committed one during
 * re-staging), and nothing is committed until the whole stage succeeds.
 */
export class MemoryPartStore implements PartStore {
    private readonly committed = new Map<number, Uint8Array>();
    private readonly quotaBytes: number;
    private committedTotal = 0;
    private stagingTotal = 0;

    constructor(opts?: { quotaBytes?: number }) {
        this.quotaBytes = opts?.quotaBytes ?? Number.POSITIVE_INFINITY;
    }

    async stagePart(
        partNumber: number,
        chunks: AsyncIterable<Uint8Array>,
    ): Promise<{ size: number }> {
        const buffered: Uint8Array[] = [];
        let localTotal = 0;
        try {
            for await (const chunk of chunks) {
                if (chunk.byteLength === 0) {
                    continue;
                }
                if (this.committedTotal + this.stagingTotal + chunk.byteLength > this.quotaBytes) {
                    throw new PartStoreQuotaError(
                        `staging part ${partNumber} would exceed the ${this.quotaBytes}-byte quota`,
                    );
                }
                // Copy: producers may reuse their buffers between yields.
                buffered.push(chunk.slice());
                this.stagingTotal += chunk.byteLength;
                localTotal += chunk.byteLength;
            }
            const part = concat(buffered, localTotal);
            const replaced = this.committed.get(partNumber);
            this.committed.set(partNumber, part);
            this.committedTotal += part.byteLength - (replaced?.byteLength ?? 0);
            return { size: part.byteLength };
        } finally {
            this.stagingTotal -= localTotal;
        }
    }

    readPart(partNumber: number): Promise<Blob> {
        const bytes = this.committed.get(partNumber);
        if (!bytes) {
            return Promise.reject(new Error(`part ${partNumber} is not committed`));
        }
        return Promise.resolve(new Blob([bytes as BlobPart]));
    }

    deletePart(partNumber: number): Promise<void> {
        const bytes = this.committed.get(partNumber);
        if (bytes) {
            this.committed.delete(partNumber);
            this.committedTotal -= bytes.byteLength;
        }
        return Promise.resolve();
    }

    listParts(): Promise<{ partNumber: number; size: number }[]> {
        const parts = [...this.committed.entries()]
            .map(([partNumber, bytes]) => ({ partNumber, size: bytes.byteLength }))
            .sort((a, b) => a.partNumber - b.partNumber);
        return Promise.resolve(parts);
    }

    destroy(): Promise<void> {
        this.committed.clear();
        this.committedTotal = 0;
        return Promise.resolve();
    }
}

function concat(chunks: Uint8Array[], totalBytes: number): Uint8Array {
    const out = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

// ---------------------------------------------------------------------------
// OPFS implementation
// ---------------------------------------------------------------------------

// Worker-only OPFS surface (createSyncAccessHandle, move, directory
// iteration) is absent from the DOM lib this app compiles against, so the
// handles are typed structurally and cast once at the OPFS boundary.
interface SyncAccessHandle {
    write(buffer: Uint8Array, options?: { at?: number }): number;
    truncate(newSize: number): void;
    flush(): void;
    close(): void;
}

interface OpfsFileHandle {
    createSyncAccessHandle(): Promise<SyncAccessHandle>;
    getFile(): Promise<File>;
    move?(name: string): Promise<void>;
}

interface OpfsDirectoryHandle {
    getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
    getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
    removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
    keys(): AsyncIterableIterator<string>;
}

/** Root OPFS directory holding one `uploads/<fileId>` dir per upload. */
export const UPLOADS_DIR = 'uploads';

const tmpName = (partNumber: number) => `part-${partNumber}.tmp`;
const binName = (partNumber: number) => `part-${partNumber}.bin`;
const COMMITTED_PART_RE = /^part-(\d+)\.bin$/;

function isDomError(err: unknown, name: string): boolean {
    return (
        (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === name) ||
        (err instanceof Error && err.name === name)
    );
}

const isNotFoundError = (err: unknown) => isDomError(err, 'NotFoundError');
const isQuotaError = (err: unknown) => isDomError(err, 'QuotaExceededError');

async function getOpfsRoot(): Promise<OpfsDirectoryHandle> {
    const storage = globalThis.navigator?.storage;
    if (!storage || typeof storage.getDirectory !== 'function') {
        throw new Error('OPFS is unavailable in this environment');
    }
    const root = await storage.getDirectory();
    return root as unknown as OpfsDirectoryHandle;
}

/**
 * OPFS-backed `PartStore`. Each upload owns `uploads/<fileId>/` in the
 * origin-private file system; parts are written through a sync access handle
 * (worker-only API) with every write's returned byte count verified, then
 * `flush()` + `close()` before the commit rename [R4]. Committed entries are
 * read with `getFile()` only.
 */
export class OpfsPartStore implements PartStore {
    /**
     * The upload's staging directory, resolved once and reused for the store's
     * lifetime. Re-walking `getDirectory()` → `uploads/` → `<fileId>/` per
     * call added three awaited directory resolutions to every stage, read and
     * delete — on the hot path of every part.
     */
    private dir: OpfsDirectoryHandle | undefined;

    constructor(private readonly fileId: string) {}

    /**
     * Delete `uploads/<id>` directories whose id is not in `liveFileIds`.
     * Callers are responsible for holding/checking the `upload:<id>` Web Lock
     * before invoking GC (Task 12) [R12].
     */
    static async gc(liveFileIds: Set<string>): Promise<void> {
        const root = await getOpfsRoot();
        let uploads: OpfsDirectoryHandle;
        try {
            uploads = await root.getDirectoryHandle(UPLOADS_DIR);
        } catch (err) {
            if (isNotFoundError(err)) {
                return; // nothing staged, nothing to collect
            }
            throw err;
        }
        const names: string[] = [];
        for await (const name of uploads.keys()) {
            names.push(name);
        }
        for (const name of names) {
            if (liveFileIds.has(name)) {
                continue;
            }
            try {
                await uploads.removeEntry(name, { recursive: true });
            } catch (err) {
                if (!isNotFoundError(err)) {
                    throw err;
                }
            }
        }
    }

    /**
     * The staging directory handle, memoized once resolved. Only a fulfilled
     * handle is cached, so a failed resolution never poisons a later call and
     * a `create: false` miss never blocks a later `create: true`.
     */
    private async getDir(create: boolean): Promise<OpfsDirectoryHandle | undefined> {
        if (this.dir) {
            return this.dir;
        }
        const root = await getOpfsRoot();
        try {
            const uploads = await root.getDirectoryHandle(UPLOADS_DIR, { create });
            this.dir = await uploads.getDirectoryHandle(this.fileId, { create });
            return this.dir;
        } catch (err) {
            if (!create && isNotFoundError(err)) {
                return undefined;
            }
            throw err;
        }
    }

    /**
     * Run `fn` against the staging directory. A memoized handle can go stale —
     * the directory is removed underneath it by teardown, GC, or storage
     * eviction — and every operation on it then throws `NotFoundError`. One
     * invalidate-and-retry separates that from the genuine "this entry does
     * not exist" answer, which simply repeats. `fn` must be safe to run twice.
     */
    private async withDir<T>(
        create: boolean,
        fn: (dir: OpfsDirectoryHandle | undefined) => Promise<T>,
    ): Promise<T> {
        const memoized = this.dir !== undefined;
        try {
            return await fn(await this.getDir(create));
        } catch (err) {
            if (!memoized || !isNotFoundError(err)) {
                throw err;
            }
            this.dir = undefined;
            return await fn(await this.getDir(create));
        }
    }

    async stagePart(
        partNumber: number,
        chunks: AsyncIterable<Uint8Array>,
    ): Promise<{ size: number }> {
        const tmp = tmpName(partNumber);
        // Only the temp entry's creation may hit a stale memoized directory,
        // and it happens before a single chunk is pulled — `chunks` is
        // one-shot, so nothing past this point may be retried.
        const { dir, tmpHandle } = await this.withDir(true, async (dir) => {
            if (!dir) {
                throw new Error('failed to open OPFS staging directory');
            }
            // Drop any temp left over from a previous failed stage of this part.
            await removeIfExists(dir, tmp);
            return { dir, tmpHandle: await dir.getFileHandle(tmp, { create: true }) };
        });
        let handle: SyncAccessHandle | undefined;
        let size = 0;
        try {
            handle = await tmpHandle.createSyncAccessHandle();
            handle.truncate(0);
            for await (const chunk of chunks) {
                if (chunk.byteLength === 0) {
                    continue;
                }
                size += writeFully(handle, chunk, size);
            }
            handle.flush();
            handle.close();
            handle = undefined;
            await commitByRename(dir, tmpHandle, tmp, binName(partNumber));
            return { size };
        } catch (err) {
            if (handle) {
                try {
                    handle.close();
                } catch {
                    // best-effort cleanup; the original error wins
                }
            }
            await removeIfExists(dir, tmp);
            if (isQuotaError(err)) {
                throw new PartStoreQuotaError(
                    `OPFS quota exhausted while staging part ${partNumber}`,
                );
            }
            throw err;
        }
    }

    async readPart(partNumber: number): Promise<Blob> {
        try {
            return await this.withDir(false, async (dir) => {
                if (!dir) {
                    throw new Error(`part ${partNumber} is not committed`);
                }
                const fileHandle = await dir.getFileHandle(binName(partNumber));
                return await fileHandle.getFile();
            });
        } catch (err) {
            if (isNotFoundError(err)) {
                throw new Error(`part ${partNumber} is not committed`);
            }
            throw err;
        }
    }

    async deletePart(partNumber: number): Promise<void> {
        await this.withDir(false, async (dir) => {
            if (dir) {
                await removeIfExists(dir, binName(partNumber));
            }
        });
    }

    listParts(): Promise<{ partNumber: number; size: number }[]> {
        return this.withDir(false, async (dir) => {
            if (!dir) {
                return [];
            }
            const names: string[] = [];
            for await (const name of dir.keys()) {
                names.push(name);
            }
            const parts: { partNumber: number; size: number }[] = [];
            for (const name of names) {
                const match = COMMITTED_PART_RE.exec(name);
                if (!match) {
                    continue;
                }
                try {
                    const fileHandle = await dir.getFileHandle(name);
                    const file = await fileHandle.getFile();
                    parts.push({ partNumber: Number(match[1]), size: file.size });
                } catch (err) {
                    // Deleted between listing and stat — skip it.
                    if (!isNotFoundError(err)) {
                        throw err;
                    }
                }
            }
            return parts.sort((a, b) => a.partNumber - b.partNumber);
        });
    }

    async destroy(): Promise<void> {
        // Drop the memoized handle first: anything still in flight (a detached
        // part deletion) must re-resolve rather than write through a handle
        // whose directory is about to disappear.
        this.dir = undefined;
        const root = await getOpfsRoot();
        let uploads: OpfsDirectoryHandle;
        try {
            uploads = await root.getDirectoryHandle(UPLOADS_DIR);
        } catch (err) {
            if (isNotFoundError(err)) {
                return;
            }
            throw err;
        }
        try {
            await uploads.removeEntry(this.fileId, { recursive: true });
        } catch (err) {
            if (!isNotFoundError(err)) {
                throw err;
            }
        }
    }
}

/**
 * Write a whole chunk at `at`, verifying every returned byte count and
 * continuing on legal partial writes. A write that makes no progress throws
 * rather than looping forever.
 */
function writeFully(handle: SyncAccessHandle, chunk: Uint8Array, at: number): number {
    let view = chunk;
    let offset = at;
    while (view.byteLength > 0) {
        const written = handle.write(view, { at: offset });
        if (!Number.isInteger(written) || written <= 0 || written > view.byteLength) {
            throw new Error(
                `OPFS write returned ${written} for a ${view.byteLength}-byte chunk at offset ${offset}`,
            );
        }
        offset += written;
        view = view.subarray(written);
    }
    return offset - at;
}

/**
 * Commit a fully-flushed temp entry to its committed name. Uses the native
 * rename (`FileSystemHandle.move`) when available; otherwise copies through a
 * fresh sync access handle and removes the temp.
 */
async function commitByRename(
    dir: OpfsDirectoryHandle,
    tmpHandle: OpfsFileHandle,
    tmp: string,
    committed: string,
): Promise<void> {
    // Re-staging replaces: drop any previously committed entry first so the
    // rename cannot collide.
    await removeIfExists(dir, committed);
    if (typeof tmpHandle.move === 'function') {
        await tmpHandle.move(committed);
        return;
    }
    const bytes = new Uint8Array(await (await tmpHandle.getFile()).arrayBuffer());
    try {
        const outHandle = await dir.getFileHandle(committed, { create: true });
        const out = await outHandle.createSyncAccessHandle();
        try {
            out.truncate(0);
            writeFully(out, bytes, 0);
            out.flush();
        } finally {
            out.close();
        }
    } catch (err) {
        // A partial copy must never look committed.
        await removeIfExists(dir, committed);
        throw err;
    }
    await removeIfExists(dir, tmp);
}

async function removeIfExists(dir: OpfsDirectoryHandle, name: string): Promise<void> {
    try {
        await dir.removeEntry(name);
    } catch (err) {
        if (!isNotFoundError(err)) {
            throw err;
        }
    }
}
