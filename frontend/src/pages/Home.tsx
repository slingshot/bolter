import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, Loader2, ChevronUp, ChevronDown, Plus } from 'lucide-react';
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
import { trackUpload } from '@/lib/plausible';
import { UPLOAD_LIMITS } from '@bolter/shared';

export function HomePage() {
  const navigate = useNavigate();
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [securityExpanded, setSecurityExpanded] = useState(true);

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
    setZippingProgress,
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
    setZippingProgress(null);

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
          onZipProgress: (percent) => {
            setZippingProgress(percent);
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
      trackUpload({ fileSize: uploaded.size, encrypted });
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
      setZippingProgress(null);
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
  const maxSize = config?.maxFileSize || UPLOAD_LIMITS.MAX_FILE_SIZE;
  const canUpload = files.length > 0 && totalSize <= maxSize && !isUploading;

  return (
    <div className="pt-24 pb-16 px-6">
      <div className="max-w-main-card mx-auto flex flex-col gap-section">
        {/* Hero */}
        <div className="text-left flex flex-col items-center gap-2">
          <h1 className="text-heading-xs text-content-primary w-full mb-2">
            Send files privately
          </h1>
          <p className="text-paragraph-xs text-content-secondary max-w-[600px] mx-auto">
            Slingshot Send lets you share files securely with links that automatically expire. Your files can be end-to-end encrypted, so only you and the people you share with can access them—not us, not AI companies, not anyone else.
          </p>
        </div>

        {/* Main Card */}
        <div className="card-glass p-card shadow-card">
          <div className="relative z-10 flex flex-col gap-5">
            {!isUploading && (
              <>
                <DropZone />

                {files.length > 0 && (
                  <div className="bg-overlay-subtle border border-border-medium rounded-element">
                    <div
                      className="border-b border-border-medium px-4 py-[14px] flex items-center justify-between cursor-pointer hover:bg-overlay-medium transition-colors"
                      onClick={() => setFilesExpanded(!filesExpanded)}
                    >
                      <p className="text-paragraph-sm text-content-primary font-medium">
                        {files.length} file{files.length !== 1 ? 's' : ''}
                        {' '}
                        <span className="font-normal">· {formatBytes(totalSize)} / {config?.maxFileSize ? formatBytes(config.maxFileSize) : '1TB'}
                        </span>
                      </p>
                      {filesExpanded ? (
                        <ChevronUp className="h-[18px] w-[18px] text-content-primary" />
                      ) : (
                        <ChevronDown className="h-[18px] w-[18px] text-content-primary" />
                      )}
                    </div>
                    {filesExpanded && (
                      <>
                        <div className="px-4 pt-2 pb-2">
                          <FileList />
                        </div>
                        <div className="px-4 pb-4">
                          <label htmlFor="file-input" className="block bg-overlay-medium border border-border-strong border-dashed rounded-element flex items-center justify-center h-[38px] cursor-pointer hover:bg-overlay-subtle transition-colors">
                            <Plus className="h-[18px] w-[18px] text-content-primary mr-2" />
                            <span className="text-paragraph-xs text-content-primary font-medium">Add files</span>
                          </label>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {files.length > 0 && (
                  <div className="bg-overlay-subtle border border-border-medium rounded-element">
                    <div
                      className="border-b border-border-medium px-4 py-[14px] flex items-center justify-between cursor-pointer hover:bg-overlay-medium transition-colors"
                      onClick={() => setSecurityExpanded(!securityExpanded)}
                    >
                      <p className="text-paragraph-sm text-content-primary font-medium">Security</p>
                      {securityExpanded ? (
                        <ChevronUp className="h-[18px] w-[18px] text-content-primary" />
                      ) : (
                        <ChevronDown className="h-[18px] w-[18px] text-content-primary" />
                      )}
                    </div>
                    {securityExpanded && (
                      <div className="px-4 pt-3 pb-4">
                        <UploadSettings />
                      </div>
                    )}
                  </div>
                )}

                {files.length > 0 && (
                  <Button
                    className="w-full"
                    onClick={handleUpload}
                    disabled={!canUpload}
                  >
                    Upload
                  </Button>
                )}

                {totalSize > maxSize && (
                  <p className="text-center text-paragraph-xs text-red-600">
                    Total size exceeds the {formatBytes(maxSize)} limit
                  </p>
                )}
              </>
            )}

            {isUploading && <UploadProgress />}
          </div>
        </div>

        {/* Recent uploads */}
        <UploadedFilesList />
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
