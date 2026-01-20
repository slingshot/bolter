import React, { useState, useEffect, useRef } from 'react';
import { File, Link2, Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes, formatTimeLimit } from '@/lib/utils';
import { useAppStore, type UploadedFile } from '@/stores/app';
import { ShareDialog } from './ShareDialog';
import { getFileInfo } from '@/lib/api';

export function UploadedFilesList() {
  const { uploadedFiles, clearUploadedFiles, removeUploadedFile, updateUploadedFile } = useAppStore();
  const [selectedFile, setSelectedFile] = useState<UploadedFile | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Filter out expired files
  const validFiles = uploadedFiles.filter(
    (f) => f.expiresAt.getTime() > Date.now()
  );

  // Poll for download count updates
  useEffect(() => {
    const pollFileInfo = async () => {
      for (const file of validFiles) {
        const info = await getFileInfo(file.id, file.ownerToken);
        if (info === null) {
          // File no longer exists - remove from list
          removeUploadedFile(file.id);
        } else if (info.dl >= info.dlimit) {
          // Download limit reached - remove from list
          removeUploadedFile(file.id);
        } else if (info.dl !== file.downloadCount) {
          // Update download count
          updateUploadedFile(file.id, { downloadCount: info.dl });
        }
      }
    };

    // Poll immediately on mount
    pollFileInfo();

    // Poll every 5 seconds
    pollIntervalRef.current = setInterval(pollFileInfo, 5000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [validFiles.length]); // Re-run when file count changes

  if (validFiles.length === 0) return null;

  return (
    <>
      <div className="card-glass p-card shadow-card">
        <div className="relative z-10 flex flex-col gap-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h3 className="text-paragraph-sm text-content-primary font-medium">
              Recent uploads
            </h3>
            <button
              onClick={clearUploadedFiles}
              className="text-paragraph-sm text-content-primary font-medium hover:text-content-secondary transition-colors"
            >
              Clear
            </button>
          </div>

          {/* Files List */}
          <div className="flex flex-col gap-3">
            {validFiles.map((file) => {
              const timeUntilExpiry = Math.max(
                0,
                (file.expiresAt.getTime() - Date.now()) / 1000
              );

              return (
                <div
                  key={file.id}
                  className="flex items-center rounded-md border border-border-medium bg-overlay-subtle"
                >
                  {/* Main content area */}
                  <div className="flex flex-1 items-center gap-2.5 border-r border-border-medium px-3 py-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-overlay-medium">
                      <File className="h-4 w-4 text-content-secondary" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-paragraph-xs text-content-primary font-medium">
                        {file.name}
                      </p>
                      <p className="text-paragraph-xxs text-content-secondary">
                        {formatBytes(file.size)} | {file.downloadLimit - file.downloadCount} download{file.downloadLimit - file.downloadCount !== 1 ? 's' : ''} left | Expires in {formatTimeLimit(timeUntilExpiry)}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 p-0"
                        onClick={() => setSelectedFile(file)}
                      >
                        <Link2 className="h-4 w-4 text-content-primary" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 p-0"
                        onClick={() => window.open(`${file.url}#${file.secretKey}`, '_blank')}
                      >
                        <Download className="h-4 w-4 text-content-primary" />
                      </Button>
                    </div>
                  </div>

                  {/* Remove button section */}
                  <div className="flex items-center p-2.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 p-0"
                      onClick={() => clearUploadedFiles()}
                    >
                      <X className="h-4 w-4 text-content-primary" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {selectedFile && (
        <ShareDialog file={selectedFile} onClose={() => setSelectedFile(null)} />
      )}
    </>
  );
}
