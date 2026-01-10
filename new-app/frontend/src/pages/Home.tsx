import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropZone } from '@/components/DropZone';
import { FileList } from '@/components/FileList';
import { UploadSettings } from '@/components/UploadSettings';
import { UploadProgress } from '@/components/UploadProgress';
import { UploadedFilesList } from '@/components/UploadedFilesList';
import { ShareDialog } from '@/components/ShareDialog';
import { useAppStore, type UploadedFile } from '@/stores/app';
import { Keychain } from '@/lib/crypto';
import { uploadFiles, Canceller } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

export function HomePage() {
  const navigate = useNavigate();
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);

  const {
    files,
    clearFiles,
    encrypted,
    timeLimit,
    downloadLimit,
    isUploading,
    setUploading,
    setUploadProgress,
    setUploadError,
    setCanceller,
    setKeychain,
    addUploadedFile,
    addToast,
    config,
  } = useAppStore();

  const handleUpload = useCallback(async () => {
    if (files.length === 0) return;

    const keychain = new Keychain();
    const canceller = new Canceller();

    setUploading(true);
    setUploadError(null);
    setCanceller(canceller);
    setKeychain(keychain);

    try {
      const result = await uploadFiles(
        {
          files: files.map((f) => f.file),
          encrypted,
          timeLimit,
          downloadLimit,
          onProgress: (progress) => {
            setUploadProgress(progress);
          },
          onError: (error) => {
            console.error('Upload error:', error);
          },
        },
        keychain,
        canceller
      );

      // Create uploaded file record
      const uploaded: UploadedFile = {
        id: result.id,
        url: result.url,
        secretKey: keychain.secretKeyB64,
        ownerToken: result.ownerToken,
        name: files.length === 1 ? files[0].file.name : `${files.length} files`,
        size: files.reduce((sum, f) => sum + f.file.size, 0),
        expiresAt: new Date(Date.now() + timeLimit * 1000),
        downloadLimit,
        downloadCount: 0,
      };

      addUploadedFile(uploaded);
      setUploadedFile(uploaded);
      clearFiles();

      addToast({
        title: 'Upload complete!',
        description: 'Your file is ready to share.',
        variant: 'success',
      });
    } catch (e: any) {
      if (e.message === 'Upload cancelled') {
        addToast({
          title: 'Upload cancelled',
          variant: 'default',
        });
      } else {
        setUploadError(e.message);
        addToast({
          title: 'Upload failed',
          description: e.message,
          variant: 'destructive',
        });
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      setCanceller(null);
      setKeychain(null);
    }
  }, [
    files,
    encrypted,
    timeLimit,
    downloadLimit,
    setUploading,
    setUploadProgress,
    setUploadError,
    setCanceller,
    setKeychain,
    addUploadedFile,
    clearFiles,
    addToast,
  ]);

  const totalSize = files.reduce((sum, f) => sum + f.file.size, 0);
  const maxSize = config?.maxFileSize || 2.5 * 1024 * 1024 * 1024;
  const canUpload = files.length > 0 && totalSize <= maxSize && !isUploading;

  return (
    <div className="container py-8">
      <div className="mx-auto max-w-2xl">
        {/* Hero */}
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            Share files securely
          </h1>
          <p className="mt-3 text-lg text-muted-foreground">
            End-to-end encrypted file sharing with automatic expiration.
            No account required.
          </p>
        </div>

        {/* Upload Card */}
        <Card>
          <CardContent className="pt-6">
            <DropZone />
            <FileList />

            {files.length > 0 && !isUploading && (
              <>
                <UploadSettings />

                <div className="mt-6">
                  <Button
                    className="w-full"
                    size="lg"
                    onClick={handleUpload}
                    disabled={!canUpload}
                  >
                    <Upload className="mr-2 h-5 w-5" />
                    Upload {files.length} file{files.length !== 1 ? 's' : ''} ({formatBytes(totalSize)})
                  </Button>

                  {totalSize > maxSize && (
                    <p className="mt-2 text-center text-sm text-destructive">
                      Total size exceeds the {formatBytes(maxSize)} limit
                    </p>
                  )}
                </div>
              </>
            )}

            {isUploading && <UploadProgress />}
          </CardContent>
        </Card>

        {/* Recent uploads */}
        <div className="mt-8">
          <UploadedFilesList />
        </div>
      </div>

      {/* Share dialog */}
      {uploadedFile && (
        <ShareDialog
          file={uploadedFile}
          onClose={() => setUploadedFile(null)}
        />
      )}
    </div>
  );
}
