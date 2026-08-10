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
import {
    Canceller,
    computeContentFingerprint,
    FileReadError,
    resumeEngineUpload,
    resumeEngineUploadWithFile,
    resumeUpload,
    uploadFiles,
} from '@/lib/api';
import { Keychain } from '@/lib/crypto';
import { trackUpload } from '@/lib/plausible';
import { addBreadcrumb, captureError } from '@/lib/sentry';
import {
    currentUploadAttempt,
    discardEngineUpload,
    type EngineResumeCandidate,
    engineStartupMaintenance,
    resetUploadAttemptTelemetry,
} from '@/lib/upload-engine/client';
import { verifyHandleFile } from '@/lib/upload-engine/resume';
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
    const [engineResumable, setEngineResumable] = useState<EngineResumeCandidate | null>(null);

    // Check for any resumable upload on mount
    useEffect(() => {
        cleanupExpiredUploads()
            .then(() => getAnyResumableUpload())
            .then((state) => setResumableUpload(state))
            .catch(() => setResumableUpload(null));
    }, [setResumableUpload]);

    // Worker-engine maintenance on mount: surface source-free resumes
    // ("Finish upload — no file selection needed"), one-click resumes backed
    // by a persisted file handle [R13], and garbage-collect orphaned OPFS
    // staging directories (dirs whose upload lock is held by another tab are
    // skipped).
    useEffect(() => {
        engineStartupMaintenance()
            .then((candidates) => {
                setEngineResumable(
                    candidates.find((c) => c.action === 'finish') ??
                        candidates.find(
                            (c) => c.action === 'need-source-single' && c.handle !== undefined,
                        ) ??
                        null,
                );
            })
            .catch(() => setEngineResumable(null));
    }, []);

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
                    // The server TTL started at /upload/url, which for a resume
                    // can be days ago — `createdAt` is stamped right after that
                    // call, so anchor the expiry there instead of restarting the
                    // clock at completion.
                    expiresAt: resolveExpiresAt(
                        result,
                        resumableUpload.timeLimit,
                        resumableUpload.createdAt,
                    ),
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

    // Shared completion for both worker-engine resume flows (source-free
    // "finish" and one-click handle resume): upload-state wiring, the history
    // entry, and toasts are identical — only the resume call differs.
    const runEngineResume = useCallback(
        async (
            candidate: EngineResumeCandidate,
            resume: (
                canceller: Canceller,
            ) => Promise<{ id: string; url: string; ownerToken: string }>,
        ) => {
            const canceller = new Canceller();
            const keychain =
                candidate.encrypted && candidate.secretKeyB64
                    ? new Keychain(candidate.secretKeyB64)
                    : new Keychain();

            setUploading(true);
            setUploadError(null);
            setCanceller(canceller);
            setKeychain(keychain);

            try {
                const result = await resume(canceller);

                const uploaded: UploadedFile = {
                    id: result.id,
                    url: result.url,
                    secretKey: keychain.secretKeyB64,
                    ownerToken: result.ownerToken,
                    name: candidate.fileName,
                    size: candidate.size,
                    // The server TTL started at /upload/url — anchor the expiry
                    // at the lease's creation, not at completion.
                    expiresAt: resolveExpiresAt(result, candidate.timeLimit, candidate.createdAt),
                    downloadLimit: candidate.downloadLimit,
                    downloadCount: 0,
                    encrypted: candidate.encrypted,
                };

                addUploadedFile(uploaded);
                setUploadedFile(uploaded);
                setEngineResumable(null);

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
            setUploading,
            setUploadError,
            setCanceller,
            setKeychain,
            setUploadProgress,
            addUploadedFile,
            addToast,
        ],
    );

    // Finish a worker-engine upload whose remaining bytes are all staged (or
    // whose completion just needs replaying) — no file selection needed.
    const handleEngineFinish = useCallback(() => {
        if (!engineResumable) {
            return;
        }
        const candidate = engineResumable;
        void runEngineResume(candidate, (canceller) =>
            resumeEngineUpload(
                candidate.fileId,
                (progress) => setUploadProgress(progress),
                canceller,
            ),
        );
    }, [engineResumable, runEngineResume, setUploadProgress]);

    // One-click resume from a persisted File System Access handle [R13]:
    // re-acquire the file (a permission prompt at most), verify it is still
    // byte-identical to the interrupted upload's source, then feed it back
    // into the engine as the resume source.
    const handleEngineHandleResume = useCallback(async () => {
        const candidate = engineResumable;
        const handle = candidate?.handle;
        const handleFacts = candidate?.handleFacts;
        if (!candidate || !handle || !handleFacts) {
            return;
        }

        let file: File;
        try {
            const permission = await (
                handle as FileSystemFileHandle & {
                    requestPermission?: (descriptor: { mode: 'read' }) => Promise<PermissionState>;
                }
            ).requestPermission?.({ mode: 'read' });
            if (permission !== undefined && permission !== 'granted') {
                addToast({
                    title: 'Permission needed',
                    description: 'Allow read access to the file to resume this upload.',
                    variant: 'destructive',
                });
                return;
            }
            file = await handle.getFile();
        } catch {
            addToast({
                title: 'File unavailable',
                description:
                    'The saved file could not be reopened. Start fresh to upload it again.',
                variant: 'destructive',
            });
            return;
        }

        try {
            await verifyHandleFile(file, handleFacts, computeContentFingerprint);
        } catch {
            addToast({
                title: 'File has changed',
                description:
                    'The saved file no longer matches the interrupted upload. Start fresh to upload the current version.',
                variant: 'destructive',
            });
            return;
        }

        await runEngineResume(candidate, (canceller) =>
            resumeEngineUploadWithFile(
                candidate.fileId,
                file,
                (progress) => setUploadProgress(progress),
                canceller,
            ),
        );
    }, [engineResumable, runEngineResume, addToast, setUploadProgress]);

    const handleEngineStartFresh = useCallback(() => {
        if (!engineResumable) {
            return;
        }
        const { fileId } = engineResumable;
        setEngineResumable(null);
        // Aborts the server-side multipart via the lease's credentials, then
        // clears engine state and the OPFS staging directory.
        discardEngineUpload(fileId).catch(() => {
            // Intentionally ignored — best-effort cleanup
        });
    }, [engineResumable]);

    const handleUpload = useCallback(async () => {
        if (files.length === 0) {
            return;
        }

        const keychain = new Keychain();
        const canceller = new Canceller();
        // The server starts the metadata TTL when /upload/url mints the id, a
        // moment or two after this. Anchoring the displayed expiry here rather
        // than at completion keeps a multi-hour upload from advertising hours
        // the server will not honor.
        const startedAt = Date.now();

        setUploading(true);
        setUploadError(null);
        setCanceller(canceller);
        setKeychain(keychain);
        setZippingProgress(null);
        // A small upload never reaches the engine delegation decision — clear
        // the previous attempt so the success event cannot inherit its engine.
        resetUploadAttemptTelemetry();

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
                    // Positional File System Access handles (Chromium) — the
                    // engine persists a single file's handle with its lease so
                    // an interrupted upload can offer one-click resume [R13].
                    handles: files.map((f) => f.handle),
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
                // The server started the TTL at /upload/url, not now.
                expiresAt: resolveExpiresAt(result, timeLimit, startedAt),
                downloadLimit,
                downloadCount: 0,
                encrypted,
            };

            addUploadedFile(uploaded);
            trackUpload({
                fileSize: uploaded.size,
                encrypted,
                engine: currentUploadAttempt()?.engine ?? 'legacy',
            });
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

                        {!isUploading && !resumableUpload && engineResumable && (
                            <div className="bg-overlay-subtle border border-border-medium rounded-element p-6 flex flex-col items-center gap-4 text-center">
                                <Upload className="h-8 w-8 text-content-secondary" />
                                <div>
                                    <p className="text-paragraph-sm font-medium text-content-primary mb-1">
                                        {engineResumable.action === 'finish'
                                            ? 'Finish upload — no file selection needed'
                                            : 'Resume upload — no file selection needed'}
                                    </p>
                                    <p className="text-paragraph-xs text-content-secondary">
                                        <span className="font-medium">
                                            {engineResumable.fileName}
                                        </span>{' '}
                                        ({formatBytes(engineResumable.size)}) &mdash;{' '}
                                        {engineResumable.action === 'finish'
                                            ? 'every remaining byte is already saved, so this upload can finish right away.'
                                            : 'a reference to the file was saved, so this upload can resume with one click.'}
                                    </p>
                                </div>
                                <div className="flex gap-3 w-full">
                                    {engineResumable.action === 'finish' ? (
                                        <Button className="flex-1" onClick={handleEngineFinish}>
                                            Finish upload
                                        </Button>
                                    ) : (
                                        <Button
                                            className="flex-1"
                                            onClick={handleEngineHandleResume}
                                        >
                                            Resume upload
                                        </Button>
                                    )}
                                    <Button variant="ghost" onClick={handleEngineStartFresh}>
                                        Start fresh
                                    </Button>
                                </div>
                            </div>
                        )}

                        {!isUploading && !resumableUpload && !engineResumable && (
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
