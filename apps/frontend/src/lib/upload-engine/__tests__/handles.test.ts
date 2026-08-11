/**
 * Persisted File System Access handles [R13]:
 * - `verifyHandleFile` proves a handle-reacquired file is still the
 *   interrupted upload's source (name/size/mtime + injected content
 *   fingerprint) before it is fed back in as the resume source.
 * - Drop traversal captures `getAsFileSystemHandle` for **top-level dropped
 *   files only**; folder-traversal files stay handleless.
 * - `FileItem.handle` rides `addFiles` positionally.
 * - The engine lease persists `handles` + `handleFacts` (IndexedDB stores
 *   handles via structured clone).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    deleteFile: vi.fn().mockResolvedValue(undefined),
    getDownloadStatus: vi.fn().mockResolvedValue({ status: 'error' }),
    API_BASE_URL: 'http://localhost:3001',
}));
vi.mock('@/lib/sentry', () => ({
    captureError: vi.fn(),
    addBreadcrumb: vi.fn(),
}));

import { processDataTransferItems } from '@/components/DropZone';
import { useAppStore } from '@/stores/app';
import { verifyHandleFile } from '../resume';
import { type EngineLease, type HandleSourceFacts, openEngineState } from '../state';

function fakeFileHandle(name: string): FileSystemFileHandle {
    return { kind: 'file', name } as unknown as FileSystemFileHandle;
}

function makeFacts(overrides: Partial<HandleSourceFacts> = {}): HandleSourceFacts {
    return {
        name: 'a.bin',
        size: 4,
        lastModified: 1_700_000_000_000,
        fingerprint: 'fp-1',
        ...overrides,
    };
}

function makeHandleFile(
    overrides: { name?: string; bytes?: number; lastModified?: number } = {},
): File {
    return new File([new Uint8Array(overrides.bytes ?? 4)], overrides.name ?? 'a.bin', {
        lastModified: overrides.lastModified ?? 1_700_000_000_000,
    });
}

describe('verifyHandleFile', () => {
    it('passes when every identity field and the fingerprint match', async () => {
        const fingerprint = vi.fn().mockResolvedValue('fp-1');
        const file = makeHandleFile();

        await expect(verifyHandleFile(file, makeFacts(), fingerprint)).resolves.toBeUndefined();
        expect(fingerprint).toHaveBeenCalledWith(file);
    });

    it('rejects on a name mismatch without reading content', async () => {
        const fingerprint = vi.fn().mockResolvedValue('fp-1');

        await expect(
            verifyHandleFile(makeHandleFile({ name: 'b.bin' }), makeFacts(), fingerprint),
        ).rejects.toThrow(/name/);
        expect(fingerprint).not.toHaveBeenCalled();
    });

    it('rejects on a size mismatch without reading content', async () => {
        const fingerprint = vi.fn().mockResolvedValue('fp-1');

        await expect(
            verifyHandleFile(makeHandleFile({ bytes: 5 }), makeFacts(), fingerprint),
        ).rejects.toThrow(/size/);
        expect(fingerprint).not.toHaveBeenCalled();
    });

    it('rejects on a lastModified mismatch without reading content', async () => {
        const fingerprint = vi.fn().mockResolvedValue('fp-1');

        await expect(
            verifyHandleFile(makeHandleFile({ lastModified: 1 }), makeFacts(), fingerprint),
        ).rejects.toThrow(/modified/);
        expect(fingerprint).not.toHaveBeenCalled();
    });

    it('rejects on a fingerprint mismatch', async () => {
        const fingerprint = vi.fn().mockResolvedValue('fp-other');

        await expect(verifyHandleFile(makeHandleFile(), makeFacts(), fingerprint)).rejects.toThrow(
            /fingerprint/,
        );
    });
});

// --- Drop-traversal doubles (same shapes DropZone.test.tsx uses) --------------

function fileEntry(name: string, fullPath = `/${name}`): FileSystemEntry {
    return {
        isFile: true,
        isDirectory: false,
        name,
        fullPath,
        file: (onSuccess: (f: File) => void) =>
            onSuccess(new File(['x'], name, { type: 'text/plain' })),
    } as unknown as FileSystemEntry;
}

function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
    return {
        isFile: false,
        isDirectory: true,
        name,
        fullPath: `/${name}`,
        createReader: () => {
            let done = false;
            return {
                readEntries: (onSuccess: (entries: FileSystemEntry[]) => void) => {
                    if (done) {
                        onSuccess([]);
                        return;
                    }
                    done = true;
                    onSuccess(children);
                },
            };
        },
    } as unknown as FileSystemEntry;
}

interface ItemSpec {
    entry: FileSystemEntry;
    /** Value `getAsFileSystemHandle()` resolves with; omit the method entirely
     * when `undefined` (non-Chromium browsers). */
    handle?: { kind: string; name: string };
}

function makeItems(specs: ItemSpec[]): DataTransferItemList {
    const items = specs.map((spec) => ({
        kind: 'file' as const,
        webkitGetAsEntry: () => spec.entry,
        ...(spec.handle !== undefined && {
            getAsFileSystemHandle: () => Promise.resolve(spec.handle),
        }),
    }));
    return Object.assign(items, { length: items.length }) as unknown as DataTransferItemList;
}

describe('drop traversal handle capture', () => {
    it('captures the handle for a top-level dropped file', async () => {
        const handle = fakeFileHandle('top.txt');
        const items = makeItems([{ entry: fileEntry('top.txt'), handle }]);

        const result = await processDataTransferItems(items);

        expect(result.files.map((f) => f.name)).toEqual(['top.txt']);
        expect(result.handles.get(result.files[0])).toBe(handle);
    });

    it('leaves folder-traversal files handleless', async () => {
        const items = makeItems([
            {
                entry: dirEntry('folder', [fileEntry('inner.txt', '/folder/inner.txt')]),
                handle: { kind: 'directory', name: 'folder' },
            },
        ]);

        const result = await processDataTransferItems(items);

        expect(result.files.map((f) => f.name)).toEqual(['folder/inner.txt']);
        expect(result.handles.size).toBe(0);
    });

    it('still adds files when getAsFileSystemHandle is absent', async () => {
        const items = makeItems([{ entry: fileEntry('plain.txt') }]);

        const result = await processDataTransferItems(items);

        expect(result.files.map((f) => f.name)).toEqual(['plain.txt']);
        expect(result.handles.size).toBe(0);
    });

    it('ignores a handle whose kind is not file', async () => {
        const items = makeItems([
            { entry: fileEntry('odd.txt'), handle: { kind: 'directory', name: 'odd.txt' } },
        ]);

        const result = await processDataTransferItems(items);

        expect(result.files.map((f) => f.name)).toEqual(['odd.txt']);
        expect(result.handles.size).toBe(0);
    });
});

describe('FileItem handles', () => {
    beforeEach(() => {
        useAppStore.setState({ files: [] });
    });

    it('addFiles attaches handles positionally', () => {
        const handle = fakeFileHandle('a.bin');
        const withHandle = new File(['x'], 'a.bin');
        const withoutHandle = new File(['y'], 'b.bin');

        useAppStore.getState().addFiles([withHandle, withoutHandle], [handle, undefined]);

        const { files } = useAppStore.getState();
        expect(files).toHaveLength(2);
        expect(files[0].handle).toBe(handle);
        expect(files[1].handle).toBeUndefined();
    });

    it('addFiles without handles stays handleless', () => {
        useAppStore.getState().addFiles([new File(['x'], 'a.bin')]);

        expect(useAppStore.getState().files[0].handle).toBeUndefined();
    });
});

describe('engine lease handle persistence', () => {
    beforeEach(async () => {
        await new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase('bolter-upload-engine');
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => resolve();
        });
    });

    it('round-trips handles and handleFacts on the lease', async () => {
        const state = await openEngineState();
        const lease: EngineLease = {
            fileId: 'file-h',
            uploadId: 'upload-h',
            ownerToken: 'owner-h',
            createdAt: 1_700_000_000_000,
            engineVersion: 1,
            handles: [fakeFileHandle('a.bin')],
            handleFacts: [makeFacts()],
        };

        await state.putLease(lease);
        const roundTripped = await state.getLease('file-h');

        // Structured clone: compare contents, not identity.
        expect(roundTripped?.handles?.map((h) => h.name)).toEqual(['a.bin']);
        expect(roundTripped?.handleFacts).toEqual([makeFacts()]);
    });
});
