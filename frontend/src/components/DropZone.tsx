import React, { useCallback, useState, useRef } from 'react';
import { ArrowUpFromLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app';
import { UPLOAD_LIMITS, BYTES } from '@bolter/shared';

// Recursively read all files from a directory entry
async function readDirectoryEntries(
  dirEntry: FileSystemDirectoryEntry
): Promise<File[]> {
  const reader = dirEntry.createReader();
  const files: File[] = [];

  // readEntries may not return all entries at once, so we need to call it repeatedly
  const readAllEntries = (): Promise<FileSystemEntry[]> => {
    return new Promise((resolve, reject) => {
      const allEntries: FileSystemEntry[] = [];

      const readBatch = () => {
        reader.readEntries(
          (entries) => {
            if (entries.length === 0) {
              resolve(allEntries);
            } else {
              allEntries.push(...entries);
              readBatch();
            }
          },
          reject
        );
      };

      readBatch();
    });
  };

  const entries = await readAllEntries();

  for (const entry of entries) {
    if (entry.isFile) {
      const file = await getFileFromEntry(entry as FileSystemFileEntry);
      if (file) {
        // Preserve the relative path for folder structure
        const relativePath = entry.fullPath.startsWith('/')
          ? entry.fullPath.slice(1)
          : entry.fullPath;
        // Create a new File object with the relative path as the name
        const fileWithPath = new File([file], relativePath, {
          type: file.type,
          lastModified: file.lastModified,
        });
        files.push(fileWithPath);
      }
    } else if (entry.isDirectory) {
      const subFiles = await readDirectoryEntries(
        entry as FileSystemDirectoryEntry
      );
      files.push(...subFiles);
    }
  }

  return files;
}

// Get a File object from a FileSystemFileEntry
function getFileFromEntry(fileEntry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    fileEntry.file(
      (file) => resolve(file),
      () => resolve(null)
    );
  });
}

// Process DataTransferItemList to handle both files and folders
async function processDataTransferItems(
  items: DataTransferItemList
): Promise<File[]> {
  const files: File[] = [];
  const entries: FileSystemEntry[] = [];

  // Collect all entries first (must be done synchronously during the event)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
      }
    }
  }

  // Process entries asynchronously
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await getFileFromEntry(entry as FileSystemFileEntry);
      if (file) {
        files.push(file);
      }
    } else if (entry.isDirectory) {
      const dirFiles = await readDirectoryEntries(
        entry as FileSystemDirectoryEntry
      );
      files.push(...dirFiles);
    }
  }

  return files;
}

export function DropZone() {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const { addFiles, config } = useAppStore();
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

      if (!e.dataTransfer.items || e.dataTransfer.items.length === 0) {
        return;
      }

      setIsProcessing(true);

      try {
        const files = await processDataTransferItems(e.dataTransfer.items);
        if (files.length > 0) {
          addFiles(files);
        }
      } catch (error) {
        console.error('Error processing dropped items:', error);
        // Fallback to basic file handling
        const files = Array.from(e.dataTransfer.files).filter(
          (f) => f.size > 0
        );
        if (files.length > 0) {
          addFiles(files);
        }
      } finally {
        setIsProcessing(false);
      }
    },
    [addFiles]
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
    [addFiles]
  );

  const handleFileClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

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
    <div
      className={cn(
        'relative flex flex-col items-center justify-center rounded-element border-2 border-dashed px-[16px] py-[20px] transition-all duration-200',
        isDragging
          ? 'border-border-medium bg-overlay-medium'
          : 'border-border-subtle bg-overlay-subtle hover:border-border-medium hover:bg-overlay-medium',
        isProcessing && 'opacity-70 pointer-events-none'
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
              </button>
              {' '}or{' '}
              <button
                type="button"
                onClick={handleFolderClick}
                className="underline decoration-solid cursor-pointer hover:text-content-secondary transition-colors"
              >
                folders
              </button>
              {' '}here
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
