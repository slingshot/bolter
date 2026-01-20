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
    <div className="flex flex-col gap-2">
      {files.map((item, index) => {
        const Icon = getFileIcon(item.file.type);

        return (
          <div key={item.id}>
            <div
              className={cn(
                'flex items-center gap-[10px] py-2',
                item.status === 'error' && 'opacity-50'
              )}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-overlay-medium">
                <Icon className="h-4 w-4 text-content-secondary" />
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-paragraph-xs text-content-primary font-medium leading-[1.5]">
                  {item.file.name}
                </p>
                <p className="text-paragraph-xxs text-content-tertiary leading-[1.5]">
                  {formatBytes(item.file.size)}
                </p>
              </div>

              {item.status === 'uploading' && (
                <div className="h-1 w-16 overflow-hidden rounded-full bg-overlay-medium">
                  <div
                    className="h-full bg-content-primary transition-all"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              )}

              {item.status === 'error' && (
                <span className="text-paragraph-xxs text-red-600">{item.error}</span>
              )}

              {!isUploading && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-[18px] w-[18px] shrink-0 p-0"
                  onClick={() => removeFile(item.id)}
                >
                  <X className="h-[18px] w-[18px] text-content-primary" />
                </Button>
              )}
            </div>
            {index < files.length - 1 && (
              <div className="h-[0.5px] bg-border-medium" />
            )}
          </div>
        );
      })}
    </div>
  );
}
