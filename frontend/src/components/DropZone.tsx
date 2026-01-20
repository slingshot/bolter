import React, { useCallback, useState } from 'react';
import { ArrowUpFromLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app';
import { UPLOAD_LIMITS, BYTES } from '@bolter/shared';

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

  const maxSize = config?.maxFileSize || UPLOAD_LIMITS.MAX_FILE_SIZE;
  const maxSizeDisplay = maxSize >= BYTES.TB
    ? Math.round(maxSize / BYTES.TB * 10) / 10
    : Math.round(maxSize / BYTES.GB * 10) / 10;

  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center rounded-element border-2 border-dashed px-[16px] py-[20px] transition-all duration-200',
        isDragging
          ? 'border-border-medium bg-overlay-medium'
          : 'border-border-subtle bg-overlay-subtle hover:border-border-medium hover:bg-overlay-medium'
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

      <ArrowUpFromLine className="h-5 w-5 text-content-primary mb-2" />

      <div className="flex flex-col items-center gap-0.5">
        <p className="text-paragraph-sm text-content-primary font-medium text-center">
          Drag files or folders here or{' '}
          <span className="underline decoration-solid cursor-pointer">select files</span>
        </p>
        <p className="text-paragraph-xs text-content-secondary">
          Send up to {maxSizeDisplay}{maxSize >= BYTES.TB ? 'TB' : 'GB'}
        </p>
      </div>
    </div>
  );
}
