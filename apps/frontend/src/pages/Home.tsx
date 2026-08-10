import { UPLOAD_LIMITS } from '@bolter/shared';
import { ChevronDown, ChevronUp, Plus, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DropZone } from '@/components/DropZone';
import { FileList } from '@/components/FileList';
import { ShareDialog } from '@/components/ShareDialog';
import { UploadedFilesList } from '@/components/UploadedFilesList';
import { UploadProgress } from '@/components/UploadProgress';
import { UploadSettings } from '@/components/UploadSettings';
import { Button } from '@/components/ui/button';
import { Canceller, FileReadError, resumeUpload, uploadFiles } from '@/lib/api';
import { Keychain } from '@/lib/crypto';
import { trackUpload } from '@/lib/plausible';
import { addBreadcrumb, captureError } from '@/lib/sentry';
import {
    cleanupExpiredUploads,
    discardResumableUpload,
    getAnyResumableUpload,
} from '@/lib/upload-state';
import { formatBytes } from '@/lib/utils';
import { resolveExpiresAt, type UploadedFile, useAppStore } from '@/stores/app';

export function HomePage() {
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
        setCheckingSpeed,
        addUploadedFile,
        addToast,
        config,
        resumableUpload,
        setResumableUpload,
    } = useAppStore();

    const resumeFileInputRef = useRef<HTMLInputElement>(null);

    // Check for any resumable upload on mount
    useEffect(() => {
        cleanupExpiredUploads()
            .then(() => getAnyResumableUpload())
            .then((state) => setResumableUpload(state))
            .catch(() => setResumableUpload(null));
    }, [setResumableUpload]);

    const handleResumeFileSelected = useCallback(
        async (file: File) => {
            if (!resumableUpload) {
                return;
            }

            // Verify the file matches
            if (
                file.name !== resumableUpload.fileName ||
                file.size !== resumableUpload.fileSize ||
                file.lastModified !== resumableUpload.fileLastModified
            ) {
                addToast({
                    title: 'Wrong file',
                    description: `Please select "${resumableUpload.fileName}" to resume the upload.`,
                    variant: 'destructive',
                });
                return;
            }

            const canceller = new Canceller();
            const keychain =
                resumableUpload.encrypted && resumableUpload.secretKeyB64
                    ? new Keychain(resumableUpload.secretKeyB64)
                    : new Keychain();

            setUploading(true);
            setUploadError(null);
            setCanceller(canceller);
            setKeychain(keychain);

            try {
                const result = await resumeUpload(
                    file,
                    resumableUpload,
                    (progress) => setUploadProgress(progress),
                    (error) => console.error('Resume error:', error),
                    canceller,
                );

                const uploaded: UploadedFile = {
                    id: result.id,
                    url: result.url,
                    secretKey: keychain.secretKeyB64,
                    ownerToken: result.ownerToken,
                    name: file.name,
                    size: file.size,
                    // The server TTL started back at /upload/url — which for a
                    // resume can be days ago — so trust the authoritative expiry
                    // from /upload/complete over a local now+timeLimit estimate.
                    expiresAt: resolveExpiresAt(result, resumableUpload.timeLimit),
                    downloadLimit: resumableUpload.downloadLimit,
                    downloadCount: 0,
                    encrypted: resumableUpload.encrypted,
                };

                addUploadedFile(uploaded);
                setUploadedFile(uploaded);
                setResumableUpload(null);

                addToast({
                    title: 'Upload resumed and completed!',
                    description: 'Your file is ready to share.',
                    variant: 'success',
                });
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                if (message !== 'Upload cancelled') {
                    setUploadError(message);
                    addToast({
                        title: 'Resume failed',
                        description: message,
                        variant: 'destructive',
                    });
                }
            } finally {
                setUploading(false);
                setUploadProgress(null);
                setCanceller(null);
                setKeychain(null);
            }
        },
        [
            resumableUpload,
            setUploading,
            setUploadError,
            setCanceller,
            setKeychain,
            setUploadProgress,
            addUploadedFile,
            addToast,
            setResumableUpload,
        ],
    );

    const handleStartFresh = useCallback(() => {
        if (!resumableUpload) {
            return;
        }
        const { fileId, uploadId } = resumableUpload;
        setResumableUpload(null);
        // Abort the server-side multipart before dropping the local record —
        // it holds the only copy of the uploadId, and without the abort the
        // uploaded S3 parts stay billable and the provider file counter stays
        // permanently incremented.
        discardResumableUpload({ fileId, uploadId }).catch(() => {
            // Intentionally ignored — best-effort cleanup
        });
    }, [resumableUpload, setResumableUpload]);

    const handleUpload = useCallback(async () => {
        if (files.length === 0) {
            return;
        }

        const keychain = new Keychain();
        const canceller = new Canceller();

        setUploading(true);
        setUploadError(null);
        setCanceller(canceller);
        setKeychain(keychain);
        setZippingProgress(null);

        addBreadcrumb('Upload started', {
            category: 'upload',
            data: {
                fileCount: files.length,
                totalSize: files.reduce((sum, f) => sum + f.file.size, 0),
                encrypted,
            },
        });

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
                    onSpeedTest: (phase) => {
                        setCheckingSpeed(phase === 'started');
                    },
                    onError: (error) => {
                        console.error('Upload error:', error);
                    },
                },
                keychain,
                canceller,
            );

            // Create uploaded file record
            const uploaded: UploadedFile = {
                id: result.id,
                url: result.url,
                secretKey: keychain.secretKeyB64,
                ownerToken: result.ownerToken,
                name: files.length === 1 ? files[0].file.name : `${files.length} files`,
                size: files.reduce((sum, f) => sum + f.file.size, 0),
                // The server started the TTL at /upload/url, not now — prefer the
                // authoritative expiry it returns from /upload/complete.
                expiresAt: resolveExpiresAt(result, timeLimit),
                downloadLimit,
                downloadCount: 0,
                encrypted,
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
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            if (message === 'Upload cancelled') {
                addToast({
                    title: 'Upload cancelled',
                    variant: 'default',
                });
            } else if (e instanceof FileReadError) {
                captureError(e.cause || e, {
                    operation: 'upload.file-read',
                    extra: {
                        fileCount: files.length,
                        totalSize: files.reduce((sum, f) => sum + f.file.size, 0),
                        encrypted,
                        errorMessage: e.message,
                    },
                });
                setUploadError(e.message);
                addToast({
                    title: 'File not accessible',
                    description: e.message,
                    variant: 'destructive',
                });
            } else {
                captureError(e, {
                    operation: 'upload',
                    extra: {
                        fileCount: files.length,
                        totalSize: files.reduce((sum, f) => sum + f.file.size, 0),
                        encrypted,
                        timeLimit,
                        downloadLimit,
                        fileNames: files
                            .map((f) => f.file.name)
                            .join(', ')
                            .substring(0, 200),
                        largestFile: Math.max(...files.map((f) => f.file.size)),
                    },
                });
                setUploadError(message);
                addToast({
                    title: 'Upload failed',
                    description: message,
                    variant: 'destructive',
                });
            }
        } finally {
            setUploading(false);
            setUploadProgress(null);
            setZippingProgress(null);
            setCheckingSpeed(false);
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
        setZippingProgress,
        setCheckingSpeed,
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
                        Slingshot Send lets you share files securely with links that automatically
                        expire. Your files can be end-to-end encrypted, so only you and the people
                        you share with can access them—not us, not AI companies, not anyone else.
                    </p>
                </div>

                {/* Main Card */}
                <div className="card-glass p-card shadow-card">
                    <div className="relative z-10 flex flex-col gap-5">
                        {!isUploading && resumableUpload && (
                            <div className="bg-overlay-subtle border border-border-medium rounded-element p-6 flex flex-col items-center gap-4 text-center">
                                <Upload className="h-8 w-8 text-content-secondary" />
                                <div>
                                    <p className="text-paragraph-sm font-medium text-content-primary mb-1">
                                        Resume interrupted upload
                                    </p>
                                    <p className="text-paragraph-xs text-content-secondary">
                                        <span className="font-medium">
                                            {resumableUpload.fileName}
                                        </span>{' '}
                                        ({formatBytes(resumableUpload.fileSize)}) &mdash;{' '}
                                        {resumableUpload.completedParts.length} of{' '}
                                        {resumableUpload.totalParts} parts completed
                                    </p>
                                </div>
                                <div className="flex gap-3 w-full">
                                    <Button
                                        className="flex-1"
                                        onClick={() => resumeFileInputRef.current?.click()}
                                    >
                                        Select file to resume
                                    </Button>
                                    <Button variant="ghost" onClick={handleStartFresh}>
                                        Start fresh
                                    </Button>
                                </div>
                                <input
                                    ref={resumeFileInputRef}
                                    type="file"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) {
                                            handleResumeFileSelected(file);
                                        }
                                        e.target.value = '';
                                    }}
                                />
                            </div>
                        )}

                        {!isUploading && !resumableUpload && (
                            <>
                                <DropZone />

                                {files.length > 0 && (
                                    <div className="bg-overlay-subtle border border-border-medium rounded-element">
                                        {/* biome-ignore lint/a11y/useSemanticElements: Expandable section header */}
                                        <div
                                            className="border-b border-border-medium px-4 py-[14px] flex items-center justify-between cursor-pointer hover:bg-overlay-medium transition-colors"
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => setFilesExpanded(!filesExpanded)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    setFilesExpanded(!filesExpanded);
                                                }
                                            }}
                                        >
                                            <p className="text-paragraph-sm text-content-primary font-medium">
                                                {files.length} file{files.length !== 1 ? 's' : ''}{' '}
                                                <span className="font-normal">
                                                    · {formatBytes(totalSize)} /{' '}
                                                    {config?.maxFileSize
                                                        ? formatBytes(config.maxFileSize)
                                                        : '1TB'}
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
                                                    <label
                                                        htmlFor="file-input"
                                                        className="block bg-overlay-medium border border-border-strong border-dashed rounded-element flex items-center justify-center h-[38px] cursor-pointer hover:bg-overlay-subtle transition-colors"
                                                    >
                                                        <Plus className="h-[18px] w-[18px] text-content-primary mr-2" />
                                                        <span className="text-paragraph-xs text-content-primary font-medium">
                                                            Add files
                                                        </span>
                                                    </label>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}

                                {files.length > 0 && (
                                    <div className="bg-overlay-subtle border border-border-medium rounded-element">
                                        {/* biome-ignore lint/a11y/useSemanticElements: Expandable section header */}
                                        <div
                                            className="border-b border-border-medium px-4 py-[14px] flex items-center justify-between cursor-pointer hover:bg-overlay-medium transition-colors"
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => setSecurityExpanded(!securityExpanded)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    setSecurityExpanded(!securityExpanded);
                                                }
                                            }}
                                        >
                                            <p className="text-paragraph-sm text-content-primary font-medium">
                                                Security
                                            </p>
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
                <ShareDialog file={uploadedFile} onClose={() => setUploadedFile(null)} />
            )}
        </div>
    );
}
