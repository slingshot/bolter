import React, { useState, useCallback, useRef } from 'react';
import { RefreshCw, X, Upload, Trash2, AlertCircle, FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { type UploadSession } from '@/lib/uploadStorage';
import { resumeUpload, Canceller, type UploadProgress } from '@/lib/api';
import { formatBytes, formatDuration, formatSpeed } from '@/lib/utils';
import { useAppStore, type UploadedFile } from '@/stores/app';
import { Keychain } from '@/lib/crypto';

interface RecoveryBannerProps {
  sessions: UploadSession[];
  onDiscard: (id: string) => Promise<void>;
  onDiscardAll: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function RecoveryBanner({
  sessions,
  onDiscard,
  onDiscardAll,
  onRefresh,
}: RecoveryBannerProps) {
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filePromptId, setFilePromptId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancellerRef = useRef<Canceller | null>(null);

  const { addUploadedFile, addToast } = useAppStore();

  const handleResume = useCallback(async (session: UploadSession, file: File | null) => {
    setResumingId(session.id);
    setProgress(null);
    setError(null);

    const canceller = new Canceller();
    cancellerRef.current = canceller;

    try {
      const result = await resumeUpload(
        {
          session,
          file,
          onProgress: setProgress,
          onError: (err) => {
            console.error('[Recovery] Upload error:', err);
          },
        },
        canceller
      );

      // Create uploaded file record
      const keychain = new Keychain(session.secretKey);
      const uploaded: UploadedFile = {
        id: result.id,
        url: result.url,
        secretKey: keychain.secretKeyB64,
        ownerToken: result.ownerToken,
        name: session.fileName,
        size: session.fileSize,
        expiresAt: new Date(Date.now() + session.expireDays * 24 * 60 * 60 * 1000),
        downloadLimit: session.downloadLimit,
        downloadCount: 0,
      };

      addUploadedFile(uploaded);
      addToast({
        title: 'Upload resumed!',
        description: 'Your file has been uploaded successfully.',
        variant: 'success',
      });

      // Refresh to remove completed session
      await onRefresh();
    } catch (e: any) {
      if (e.message === 'Upload cancelled') {
        addToast({
          title: 'Upload cancelled',
          variant: 'default',
        });
      } else if (e.message === 'FILE_NOT_AVAILABLE') {
        // Prompt user to select file
        setFilePromptId(session.id);
        setError('Please select the original file to continue');
      } else if (e.message === 'FILE_MISMATCH') {
        setError('The selected file does not match the original');
      } else {
        setError(e.message || 'Failed to resume upload');
        addToast({
          title: 'Resume failed',
          description: e.message || 'Failed to resume upload',
          variant: 'destructive',
        });
      }
    } finally {
      setResumingId(null);
      setProgress(null);
      cancellerRef.current = null;
    }
  }, [addUploadedFile, addToast, onRefresh]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !filePromptId) return;

    const session = sessions.find(s => s.id === filePromptId);
    if (session) {
      setFilePromptId(null);
      setError(null);
      handleResume(session, file);
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [filePromptId, sessions, handleResume]);

  const handleCancel = useCallback(() => {
    cancellerRef.current?.cancel();
  }, []);

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="bg-overlay-subtle border border-border-medium rounded-element p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-yellow-500" />
          <h3 className="text-paragraph-sm font-medium text-content-primary">
            Interrupted Uploads
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={!!resumingId}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {sessions.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDiscardAll}
              disabled={!!resumingId}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Discard All
            </Button>
          )}
        </div>
      </div>

      <p className="text-paragraph-xs text-content-secondary mb-4">
        {sessions.length === 1
          ? 'You have an interrupted upload that can be resumed.'
          : `You have ${sessions.length} interrupted uploads that can be resumed.`}
      </p>

      <div className="space-y-3">
        {sessions.map((session) => {
          const isResuming = resumingId === session.id;
          const progressPercent = session.completedParts.length / session.totalParts * 100;
          const completedBytes = session.completedParts.reduce((sum, p) => sum + p.size, 0);

          return (
            <div
              key={session.id}
              className="bg-overlay-medium border border-border-light rounded-element p-3"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileUp className="h-4 w-4 text-content-secondary flex-shrink-0" />
                  <span className="text-paragraph-sm text-content-primary truncate">
                    {session.fileName}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!isResuming && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleResume(session, null)}
                      >
                        <Upload className="h-4 w-4 mr-1" />
                        Resume
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDiscard(session.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  {isResuming && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancel}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Cancel
                    </Button>
                  )}
                </div>
              </div>

              {/* Progress info */}
              <div className="mb-2">
                <Progress
                  value={isResuming && progress ? progress.percentage : progressPercent}
                  className="h-1.5"
                  indicatorClassName={isResuming ? 'progress-bar-animated' : ''}
                />
              </div>

              <div className="flex items-center justify-between text-paragraph-xs text-content-secondary">
                <span>
                  {isResuming && progress
                    ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
                    : `${formatBytes(completedBytes)} / ${formatBytes(session.encryptedSize)}`
                  }
                  {' '}
                  ({session.completedParts.length} / {session.totalParts} parts)
                </span>
                {isResuming && progress && progress.speed > 0 && (
                  <span>
                    {formatSpeed(progress.speed)}
                    {progress.remainingTime > 0 && ` · ${formatDuration(progress.remainingTime)} left`}
                  </span>
                )}
                {!isResuming && (
                  <span>
                    {Math.round(progressPercent)}% complete
                  </span>
                )}
              </div>

              {/* Error message */}
              {error && filePromptId === session.id && (
                <div className="mt-2 text-paragraph-xs text-yellow-600">
                  {error}
                </div>
              )}

              {/* File selection prompt */}
              {filePromptId === session.id && (
                <div className="mt-3">
                  <label className="block bg-overlay-subtle border border-border-strong border-dashed rounded-element p-3 text-center cursor-pointer hover:bg-overlay-medium transition-colors">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                    <FileUp className="h-5 w-5 text-content-secondary mx-auto mb-1" />
                    <span className="text-paragraph-xs text-content-secondary">
                      Select <strong>{session.fileList[0]?.name}</strong> to continue
                    </span>
                  </label>
                </div>
              )}

              {/* Resuming indicator */}
              {isResuming && !progress && (
                <div className="mt-2 flex items-center gap-2 text-paragraph-xs text-content-secondary">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Preparing to resume...</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        className="hidden"
      />
    </div>
  );
}
