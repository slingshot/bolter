import React, { useState } from 'react';
import { Link2, Clock, Download, ExternalLink, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, formatBytes, formatTimeLimit } from '@/lib/utils';
import { useAppStore, type UploadedFile } from '@/stores/app';
import { ShareDialog } from './ShareDialog';

export function UploadedFilesList() {
  const { uploadedFiles, clearUploadedFiles } = useAppStore();
  const [selectedFile, setSelectedFile] = useState<UploadedFile | null>(null);

  // Filter out expired files
  const validFiles = uploadedFiles.filter(
    (f) => f.expiresAt.getTime() > Date.now()
  );

  if (validFiles.length === 0) return null;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">Recent Uploads</CardTitle>
          <Button variant="ghost" size="sm" onClick={clearUploadedFiles}>
            Clear all
          </Button>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {validFiles.map((file) => {
              const timeUntilExpiry = Math.max(
                0,
                (file.expiresAt.getTime() - Date.now()) / 1000
              );

              return (
                <div
                  key={file.id}
                  className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Link2 className="h-5 w-5 text-primary" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{file.name}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{formatBytes(file.size)}</span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatTimeLimit(timeUntilExpiry)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Download className="h-3 w-3" />
                        {file.downloadLimit - file.downloadCount} left
                      </span>
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedFile(file)}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Share
                  </Button>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {selectedFile && (
        <ShareDialog file={selectedFile} onClose={() => setSelectedFile(null)} />
      )}
    </>
  );
}
