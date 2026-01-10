import React, { useCallback, useState } from 'react';
import { Upload, FileIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app';

export function DropZone() {
  const [isDragging, setIsDragging] = useState(false);
  const { addFiles, config } = useAppStore();

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
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        addFiles(files);
      }
    },
    [addFiles]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if (files.length > 0) {
        addFiles(files);
      }
      // Reset input
      e.target.value = '';
    },
    [addFiles]
  );

  const maxSize = config?.maxFileSize || 2.5 * 1024 * 1024 * 1024;
  const maxSizeDisplay = Math.round(maxSize / (1024 * 1024 * 1024) * 10) / 10;

  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-all duration-200',
        isDragging
          ? 'border-primary bg-primary/5 scale-[1.02]'
          : 'border-border hover:border-primary/50 hover:bg-muted/50'
      )}
      onDragEnter={handleDragIn}
      onDragLeave={handleDragOut}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      <input
        type="file"
        multiple
        onChange={handleFileInput}
        className="absolute inset-0 cursor-pointer opacity-0"
        id="file-input"
      />

      <div
        className={cn(
          'flex h-16 w-16 items-center justify-center rounded-full transition-colors',
          isDragging ? 'bg-primary/20' : 'bg-muted'
        )}
      >
        {isDragging ? (
          <FileIcon className="h-8 w-8 text-primary animate-pulse" />
        ) : (
          <Upload className="h-8 w-8 text-muted-foreground" />
        )}
      </div>

      <h3 className="mt-6 text-lg font-semibold">
        {isDragging ? 'Drop files here' : 'Drag & drop files'}
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        or click to browse your files
      </p>

      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-2 py-1">
          Max {maxSizeDisplay}GB per upload
        </span>
        <span className="rounded bg-muted px-2 py-1">
          End-to-end encrypted
        </span>
      </div>
    </div>
  );
}
