import React from 'react';
import { X, File, FileText, Image, Video, Music, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, formatBytes } from '@/lib/utils';
import { useAppStore } from '@/stores/app';

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  image: Image,
  video: Video,
  audio: Music,
  text: FileText,
  archive: Archive,
  default: File,
};

function getFileIcon(type: string) {
  if (type.startsWith('image/')) return iconMap.image;
  if (type.startsWith('video/')) return iconMap.video;
  if (type.startsWith('audio/')) return iconMap.audio;
  if (type.startsWith('text/') || type.includes('pdf')) return iconMap.text;
  if (type.includes('zip') || type.includes('tar') || type.includes('archive')) return iconMap.archive;
  return iconMap.default;
}

export function FileList() {
  const { files, removeFile, isUploading } = useAppStore();

  if (files.length === 0) return null;

  const totalSize = files.reduce((sum, f) => sum + f.file.size, 0);

  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-muted-foreground">
          {files.length} file{files.length !== 1 ? 's' : ''} selected
        </h4>
        <span className="text-sm text-muted-foreground">{formatBytes(totalSize)}</span>
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border bg-card p-2">
        {files.map((item) => {
          const Icon = getFileIcon(item.file.type);

          return (
            <div
              key={item.id}
              className={cn(
                'flex items-center gap-3 rounded-md p-2 transition-colors',
                item.status === 'error'
                  ? 'bg-destructive/10'
                  : 'hover:bg-muted'
              )}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(item.file.size)}</p>
              </div>

              {item.status === 'uploading' && (
                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              )}

              {item.status === 'error' && (
                <span className="text-xs text-destructive">{item.error}</span>
              )}

              {!isUploading && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => removeFile(item.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
