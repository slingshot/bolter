import React from 'react';
import { X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn, formatBytes, formatSpeed, formatDuration } from '@/lib/utils';
import { useAppStore } from '@/stores/app';

export function UploadProgress() {
  const { isUploading, uploadProgress, currentCanceller } = useAppStore();

  if (!isUploading || !uploadProgress) return null;

  const handleCancel = () => {
    currentCanceller?.cancel();
  };

  return (
    <div className="mt-6 rounded-lg border bg-card p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <span className="font-medium">Uploading...</span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleCancel}>
          <X className="mr-2 h-4 w-4" />
          Cancel
        </Button>
      </div>

      <div className="mt-4">
        <Progress
          value={uploadProgress.percentage}
          className="h-2"
          indicatorClassName="progress-bar-animated"
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>
            {formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)}
          </span>
          <span>{Math.round(uploadProgress.percentage)}%</span>
        </div>
        <div className="flex items-center gap-4">
          <span>{formatSpeed(uploadProgress.speed)}</span>
          {uploadProgress.remainingTime > 0 && (
            <span>{formatDuration(uploadProgress.remainingTime)} remaining</span>
          )}
        </div>
      </div>
    </div>
  );
}
