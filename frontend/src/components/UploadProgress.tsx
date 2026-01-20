import React from 'react';
import { X, Loader2, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatBytes, formatSpeed, formatDuration } from '@/lib/utils';
import { useAppStore } from '@/stores/app';

export function UploadProgress() {
  const { isUploading, uploadProgress, zippingProgress, currentCanceller } = useAppStore();

  if (!isUploading) return null;

  const handleCancel = () => {
    currentCanceller?.cancel();
  };

  // Determine current phase
  const isZipping = zippingProgress !== null && zippingProgress < 100 && !uploadProgress;
  const isUploading_ = uploadProgress !== null;

  // Show initial state before progress data is available
  const percentage = isZipping ? zippingProgress : (uploadProgress?.percentage ?? 0);
  const loaded = uploadProgress?.loaded ?? 0;
  const total = uploadProgress?.total ?? 0;
  const speed = uploadProgress?.speed ?? 0;
  const remainingTime = uploadProgress?.remainingTime ?? 0;

  // Status text
  let statusText = 'Preparing upload...';
  if (isZipping) {
    statusText = 'Compressing files...';
  } else if (isUploading_) {
    statusText = 'Uploading...';
  }

  return (
    <div className="bg-overlay-subtle border border-border-medium rounded-element p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isZipping ? (
            <Archive className="h-5 w-5 text-content-primary" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-content-primary" />
          )}
          <span className="text-paragraph-sm font-medium text-content-primary">
            {statusText}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleCancel}>
          <X className="mr-2 h-4 w-4" />
          Cancel
        </Button>
      </div>

      <div className="mt-4">
        <Progress
          value={percentage}
          className="h-2"
          indicatorClassName="progress-bar-animated"
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-paragraph-xs text-content-secondary">
        {isZipping ? (
          <span>{Math.round(zippingProgress ?? 0)}% compressed</span>
        ) : (
          <>
            <div className="flex items-center gap-4">
              <span>
                {formatBytes(loaded)} / {formatBytes(total)}
              </span>
              <span>{Math.round(uploadProgress?.percentage ?? 0)}%</span>
            </div>
            <div className="flex items-center gap-4">
              <span>{formatSpeed(speed)}</span>
              {remainingTime > 0 && (
                <span>{formatDuration(remainingTime)} remaining</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
