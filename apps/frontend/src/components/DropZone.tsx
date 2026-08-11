import { BYTES, UPLOAD_LIMITS } from '@bolter/shared';
import { ArrowUpFromLine } from 'lucide-react';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { captureError } from '@/lib/sentry';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app';

/**
 * Result of a fault-tolerant drop traversal.
 *
 * A folder drop must never be all-or-nothing: one un-enumerable subdirectory or
 * one unreadable file used to reject the whole traversal and silently discard
 * every file that HAD been read. Successes are collected, failures are counted
 * so the UI can tell the user what was skipped.
 */
export interface DropTraversal {
    files: File[];
    skipped: number;
    /**
     * File System Access handles for **top-level dropped files only**
     * (Chromium [R13]), keyed by the exact `File` object in `files`.
     * Folder-traversal files are re-wrapped `File` objects and stay
     * handleless by design.
     */
    handles: Map<File, FileSystemFileHandle>;
}

/** `getAsFileSystemHandle` is a Chromium extension absent from lib.dom. */
type HandleCapableItem = DataTransferItem & {
    getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
};

/** `showOpenFilePicker` (File System Access API) is absent from lib.dom. */
type FilePickerWindow = Window & {
    showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
};

// readEntries may not return all entries at once, so it must be called
// repeatedly. Resolves with whatever was read; `failed` marks a partial read.
function readAllDirectoryEntries(
    reader: FileSystemDirectoryReader,
): Promise<{ entries: FileSystemEntry[]; failed: boolean }> {
    return new Promise((resolve) => {
        const allEntries: FileSystemEntry[] = [];

        const readBatch = () => {
            try {
                reader.readEntries(
                    (entries) => {
                        if (entries.length === 0) {
                            resolve({ entries: allEntries, failed: false });
                        } else {
                            allEntries.push(...entries);
                            readBatch();
                        }
                    },
                    () => resolve({ entries: allEntries, failed: true }),
                );
            } catch {
                resolve({ entries: allEntries, failed: true });
            }
        };

        readBatch();
    });
}

// Recursively read all files from a directory entry, tolerating per-entry errors
async function readDirectoryEntries(
    dirEntry: FileSystemDirectoryEntry,
    acc: DropTraversal,
): Promise<void> {
    let reader: FileSystemDirectoryReader;
    try {
        reader = dirEntry.createReader();
    } catch {
        acc.skipped++;
        return;
    }

    const { entries, failed } = await readAllDirectoryEntries(reader);
    if (failed) {
        // We could not enumerate the whole directory — keep what we did read.
        acc.skipped++;
    }

    for (const entry of entries) {
        if (entry.isFile) {
            const file = await getFileFromEntry(entry as FileSystemFileEntry);
            if (!file) {
                acc.skipped++;
                continue;
            }
            // Preserve the relative path for folder structure
            const relativePath = entry.fullPath.startsWith('/')
                ? entry.fullPath.slice(1)
                : entry.fullPath;
            // Create a new File object with the relative path as the name
            const fileWithPath = new File([file], relativePath, {
                type: file.type,
                lastModified: file.lastModified,
            });
            acc.files.push(fileWithPath);
        } else if (entry.isDirectory) {
            try {
                await readDirectoryEntries(entry as FileSystemDirectoryEntry, acc);
            } catch {
                acc.skipped++;
            }
        }
    }
}

// Get a File object from a FileSystemFileEntry
function getFileFromEntry(fileEntry: FileSystemFileEntry): Promise<File | null> {
    return new Promise((resolve) => {
        try {
            fileEntry.file(
                (file) => resolve(file),
                () => resolve(null),
            );
        } catch {
            resolve(null);
        }
    });
}

// Process DataTransferItemList to handle both files and folders
export async function processDataTransferItems(
    items: DataTransferItemList,
): Promise<DropTraversal> {
    const acc: DropTraversal = { files: [], skipped: 0, handles: new Map() };
    const entries: {
        entry: FileSystemEntry;
        handle: Promise<FileSystemHandle | null> | null;
    }[] = [];

    // Collect all entries first (must be done synchronously during the event)
    for (let i = 0; i < items.length; i++) {
        const item = items[i] as HandleCapableItem;
        if (item.kind === 'file') {
            let entry: FileSystemEntry | null = null;
            try {
                entry = item.webkitGetAsEntry();
            } catch {
                entry = null;
            }
            if (entry) {
                // The File System Access handle must also be requested
                // synchronously during the event. Only top-level *file*
                // entries get one [R13] — folder-traversal files are
                // re-wrapped `File` objects a handle cannot describe.
                let handle: Promise<FileSystemHandle | null> | null = null;
                if (entry.isFile && typeof item.getAsFileSystemHandle === 'function') {
                    try {
                        handle = item.getAsFileSystemHandle().catch(() => null);
                    } catch {
                        handle = null;
                    }
                }
                entries.push({ entry, handle });
            }
        }
    }

    // Process entries asynchronously — one bad entry must not lose the rest
    for (const { entry, handle } of entries) {
        try {
            if (entry.isFile) {
                const file = await getFileFromEntry(entry as FileSystemFileEntry);
                if (file) {
                    acc.files.push(file);
                    const resolved = handle ? await handle : null;
                    if (resolved && resolved.kind === 'file') {
                        acc.handles.set(file, resolved as FileSystemFileHandle);
                    }
                } else {
                    acc.skipped++;
                }
            } else if (entry.isDirectory) {
                await readDirectoryEntries(entry as FileSystemDirectoryEntry, acc);
            }
        } catch {
            acc.skipped++;
        }
    }

    return acc;
}

export function DropZone() {
    const [isDragging, setIsDragging] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const { addFiles, addToast, config } = useAppStore();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);

    const handleDrag = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDragIn = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            setIsDragging(true);
        }
    }, []);

    const handleDragOut = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback(
        async (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);

            // Snapshot the plain file list SYNCHRONOUSLY. After the first await
            // the DataTransfer is neutered/protected and `files` reads empty, so
            // the fallback path had nothing left to recover.
            const droppedFiles = Array.from(e.dataTransfer.files ?? []);
            const items = e.dataTransfer.items;
            // Count only `kind === 'file'` items, synchronously. Dragging a URL,
            // a text selection or an image from another page produces `string`
            // items and no files at all — that is a no-op, not a failed drop,
            // and must not raise "Nothing was added".
            let fileItemCount = 0;
            for (let i = 0; i < (items?.length ?? 0); i++) {
                if (items[i].kind === 'file') {
                    fileItemCount++;
                }
            }

            if (fileItemCount === 0 && droppedFiles.length === 0) {
                return;
            }

            setIsProcessing(true);

            let files: File[] = [];
            let skipped = 0;
            let handles: Map<File, FileSystemFileHandle> | null = null;

            try {
                if (fileItemCount > 0) {
                    const traversal = await processDataTransferItems(items);
                    files = traversal.files;
                    skipped = traversal.skipped;
                    handles = traversal.handles;
                }
                if (files.length === 0 && droppedFiles.length > 0) {
                    // Nothing came back from the entry traversal — fall back to
                    // the synchronous snapshot rather than dropping everything.
                    files = droppedFiles.filter((f) => f.size > 0);
                }
            } catch (error) {
                console.error('Error processing dropped items:', error);
                captureError(error, { operation: 'dropzone.process' });
                files = droppedFiles.filter((f) => f.size > 0);
            } finally {
                setIsProcessing(false);
            }

            if (files.length > 0) {
                // Snapshot-fallback files never appear in the traversal's
                // handle map, so they stay handleless here automatically.
                addFiles(files, handles ? files.map((f) => handles?.get(f)) : undefined);
            }

            if (files.length === 0) {
                addToast({
                    title: 'Nothing was added',
                    description:
                        'None of the dropped items could be read. Try selecting them with the file picker instead.',
                    variant: 'destructive',
                });
            } else if (skipped > 0) {
                addToast({
                    title: `${skipped} item${skipped === 1 ? '' : 's'} skipped`,
                    description: `${files.length} file${files.length === 1 ? '' : 's'} added. Some items could not be read and were left out.`,
                    variant: 'destructive',
                });
            }
        },
        [addFiles, addToast],
    );

    const handleFileInput = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            if (files.length > 0) {
                // For folder input, preserve relative paths using webkitRelativePath
                const filesWithPaths = files.map((file) => {
                    if (file.webkitRelativePath) {
                        return new File([file], file.webkitRelativePath, {
                            type: file.type,
                            lastModified: file.lastModified,
                        });
                    }
                    return file;
                });
                addFiles(filesWithPaths);
            }
            // Reset input
            e.target.value = '';
        },
        [addFiles],
    );

    const handleFileClick = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const win = window as FilePickerWindow;
            if (!('showOpenFilePicker' in window) || typeof win.showOpenFilePicker !== 'function') {
                fileInputRef.current?.click();
                return;
            }
            // File System Access picker (Chromium): picked files carry handles,
            // enabling one-click resume of an interrupted upload [R13]. Called
            // directly in the click handler — the picker needs user activation.
            const picker = win.showOpenFilePicker.bind(win);
            void (async () => {
                let picked: { file: File; handle: FileSystemFileHandle }[];
                try {
                    const handles = await picker({ multiple: true });
                    picked = await Promise.all(
                        handles.map(async (handle) => ({ file: await handle.getFile(), handle })),
                    );
                } catch (error) {
                    // AbortError = the user dismissed the picker: a no-op, not
                    // a failed pick — re-opening the plain input would nag.
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        return;
                    }
                    // Anything else (permissions policy, sandboxed frame, …):
                    // fall back to the plain input.
                    fileInputRef.current?.click();
                    return;
                }
                if (picked.length > 0) {
                    addFiles(
                        picked.map((p) => p.file),
                        picked.map((p) => p.handle),
                    );
                }
            })();
        },
        [addFiles],
    );

    const handleFolderClick = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        folderInputRef.current?.click();
    }, []);

    const maxSize = config?.maxFileSize || UPLOAD_LIMITS.MAX_FILE_SIZE;
    const maxSizeDisplay =
        maxSize >= BYTES.TB
            ? Math.round((maxSize / BYTES.TB) * 10) / 10
            : Math.round((maxSize / BYTES.GB) * 10) / 10;

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: Drop zone uses drag events, not click interactions
        <div
            className={cn(
                'relative flex flex-col items-center justify-center rounded-element border-2 border-dashed px-[16px] py-[20px] transition-all duration-200',
                isDragging
                    ? 'border-border-medium bg-overlay-medium'
                    : 'border-border-subtle bg-overlay-subtle hover:border-border-medium hover:bg-overlay-medium',
                isProcessing && 'opacity-70 pointer-events-none',
            )}
            onDragEnter={handleDragIn}
            onDragLeave={handleDragOut}
            onDragOver={handleDrag}
            onDrop={handleDrop}
        >
            {/* Hidden file input */}
            <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileInput}
                className="hidden"
                id="file-input"
            />

            {/* Hidden folder input */}
            <input
                ref={folderInputRef}
                type="file"
                // @ts-expect-error webkitdirectory is not in the standard types
                webkitdirectory=""
                onChange={handleFileInput}
                className="hidden"
                id="folder-input"
            />

            <ArrowUpFromLine className="h-5 w-5 text-content-primary mb-2" />

            <div className="flex flex-col items-center gap-0.5">
                <p className="text-paragraph-sm text-content-primary font-medium text-center">
                    {isProcessing ? (
                        'Processing files...'
                    ) : (
                        <>
                            Drag{' '}
                            <button
                                type="button"
                                onClick={handleFileClick}
                                className="underline decoration-solid cursor-pointer hover:text-content-secondary transition-colors"
                            >
                                files
                            </button>{' '}
                            or{' '}
                            <button
                                type="button"
                                onClick={handleFolderClick}
                                className="underline decoration-solid cursor-pointer hover:text-content-secondary transition-colors"
                            >
                                folders
                            </button>{' '}
                            here
                        </>
                    )}
                </p>
                <p className="text-paragraph-xs text-content-secondary">
                    Send up to {maxSizeDisplay}
                    {maxSize >= BYTES.TB ? 'TB' : 'GB'}
                </p>
            </div>
        </div>
    );
}
