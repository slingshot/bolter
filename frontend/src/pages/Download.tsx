import {
    AlertCircle,
    Archive,
    CheckCircle2,
    Download,
    FileIcon,
    Loader2,
    Lock,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { DownloadFileTree } from '@/components/DownloadFileTree';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useDocumentMeta } from '@/hooks/useDocumentMeta';
import {
    API_BASE_URL,
    checkLegacyFile,
    type DownloadPhase,
    downloadFile,
    fileExists,
    getDownloadStatus,
    getMetadata,
} from '@/lib/api';
import { Keychain } from '@/lib/crypto';
import { trackDownload } from '@/lib/plausible';
import { addBreadcrumb, captureError } from '@/lib/sentry';
import { formatBytes, formatTimeLimit, triggerDownload } from '@/lib/utils';

type DownloadState = 'loading' | 'ready' | 'downloading' | 'complete' | 'error' | 'not-found';

interface FileMetadata {
    name: string;
    size: number;
    type: string;
    ttl: number;
    encrypted: boolean;
    files?: { name: string; size: number; type: string }[];
    zipped?: boolean;
    zipFilename?: string;
}

export function DownloadPage() {
    const { id } = useParams<{ id: string }>();
    const location = useLocation();
    const navigate = useNavigate();

    const [state, setState] = useState<DownloadState>('loading');
    const [metadata, setMetadata] = useState<FileMetadata | null>(null);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [keychain, setKeychain] = useState<Keychain | null>(null);
    const [canDownloadAgain, setCanDownloadAgain] = useState(true);
    const [downloadsLeft, setDownloadsLeft] = useState<number | null>(null);
    const [downloadPhase, setDownloadPhase] = useState<DownloadPhase>('downloading');
    const loadingRef = useRef(false);

    // Compute document meta based on state and metadata
    const documentMeta = useMemo(() => {
        if (state === 'not-found') {
            return {
                title: 'File Not Found',
                description: 'This file may have expired or been deleted.',
            };
        }
        if (state === 'error') {
            return {
                title: 'Download Error',
                description: 'An error occurred while downloading the file.',
            };
        }
        if (metadata) {
            const isMultiFile = metadata.files && metadata.files.length > 1;
            const fileName = isMultiFile ? `${metadata.files?.length} files` : metadata.name;
            const fileSize = formatBytes(
                isMultiFile ? metadata.files?.reduce((sum, f) => sum + f.size, 0) : metadata.size,
            );
            return {
                title: `Download ${fileName}`,
                description: `${fileName} (${fileSize}) - Securely shared via Slingshot Send`,
            };
        }
        return { title: 'Download', description: 'Downloading secure file' };
    }, [state, metadata]);

    // Update document title and meta description
    useDocumentMeta(documentMeta);

    // Extract secret key from URL hash
    useEffect(() => {
        if (!id) {
            setState('not-found');
            return;
        }

        // Prevent duplicate requests from StrictMode double-render
        if (loadingRef.current) {
            return;
        }
        loadingRef.current = true;

        const secretKey = location.hash.slice(1); // Remove the # prefix

        async function loadMetadata() {
            try {
                // Check if file exists
                const exists = await fileExists(id);
                if (!exists) {
                    // Check legacy system before showing not found
                    const legacyUrl = await checkLegacyFile(id);
                    if (legacyUrl) {
                        window.location.href = legacyUrl;
                        return;
                    }
                    setState('not-found');
                    return;
                }

                // Create keychain early so it can be used for authenticated status checks
                // (crypto.subtle requires a secure context: HTTPS or localhost)
                const kc = secretKey && crypto?.subtle ? new Keychain(secretKey) : null;
                setKeychain(kc);

                // Check if download limit already reached
                const status = await getDownloadStatus(id, kc);
                if (status && status.dl >= status.dlimit) {
                    setState('not-found');
                    return;
                }

                // Store downloads left for display
                if (status) {
                    setDownloadsLeft(status.dlimit - status.dl);
                }

                // Fetch metadata
                const meta = await getMetadata(id, kc || undefined);
                setMetadata(meta as FileMetadata);
                setState('ready');
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                console.error('Failed to load metadata:', e);
                if (message.includes('404') || message.includes('401')) {
                    setState('not-found');
                } else {
                    captureError(e, {
                        operation: 'download.metadata',
                        extra: {
                            fileId: id,
                            hasSecretKey: !!secretKey,
                            errorMessage: message,
                            httpStatus: message.match(/HTTP (\d+)/)?.[1],
                        },
                    });
                    setError(message);
                    setState('error');
                }
            }
        }

        loadMetadata();
    }, [id, location.hash]);

    const handleDownload = async () => {
        if (!id) {
            return;
        }

        // Direct download for unencrypted files (uses native browser download)
        // Works for: single files, or multi-file zips (zipped at upload time)
        const canDirectDownload =
            metadata &&
            !metadata.encrypted &&
            (metadata.zipped || !metadata.files || metadata.files.length <= 1);

        if (canDirectDownload) {
            // Use hidden iframe to trigger download without leaving the page
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.src = `${API_BASE_URL}/download/direct/${id}`;
            document.body.appendChild(iframe);

            // Clean up iframe and check if download limit was reached
            setTimeout(async () => {
                document.body.removeChild(iframe);
                // Check download count vs limit to determine if more downloads available
                const status = await getDownloadStatus(id, keychain);
                const hasMoreDownloads = status ? status.dl < status.dlimit : false;
                setCanDownloadAgain(hasMoreDownloads);
                if (status) {
                    setDownloadsLeft(status.dlimit - status.dl);
                }
                trackDownload({ fileId: id });
                setState('complete');
            }, 1500);
            return;
        }

        // JavaScript-based download for encrypted files or multiple files (needs decryption/ZIP)
        addBreadcrumb('Download started', {
            category: 'download',
            data: {
                fileId: id,
                encrypted: metadata?.encrypted,
                size: metadata?.size,
            },
        });
        setState('downloading');
        setProgress(0);
        setDownloadPhase('downloading');

        try {
            const result = await downloadFile(
                id,
                keychain,
                (loaded, total) => {
                    setProgress((loaded / total) * 100);
                },
                (phase) => {
                    setDownloadPhase(phase);
                },
            );

            // Trigger browser download
            triggerDownload(result.blob, result.filename);

            // Check download count vs limit to determine if more downloads available
            const status = await getDownloadStatus(id, keychain);
            const hasMoreDownloads = status ? status.dl < status.dlimit : false;
            setCanDownloadAgain(hasMoreDownloads);
            if (status) {
                setDownloadsLeft(status.dlimit - status.dl);
            }
            trackDownload({ fileId: id });
            setState('complete');
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error('Download failed:', e);
            captureError(e, {
                operation: 'download',
                extra: {
                    fileId: id,
                    encrypted: metadata?.encrypted,
                    size: metadata?.size,
                    fileCount: metadata?.files?.length,
                    zipped: metadata?.zipped,
                    ttl: metadata?.ttl,
                    errorMessage: message,
                },
            });
            setError(message);
            setState('error');
        }
    };

    // Loading state
    if (state === 'loading') {
        return (
            <div className="pt-24 pb-16 px-6">
                <div className="max-w-main-card mx-auto">
                    <div className="card-glass p-card shadow-card">
                        <div className="relative z-10 flex flex-col items-center gap-5 py-8">
                            <Loader2 className="h-10 w-10 animate-spin text-content-primary" />
                            <p className="text-paragraph-sm text-content-secondary">
                                Loading file information...
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Not found state
    if (state === 'not-found') {
        return (
            <div className="pt-24 pb-16 px-6">
                <div className="max-w-main-card mx-auto">
                    <div className="card-glass p-card shadow-card">
                        <div className="relative z-10 flex flex-col items-center gap-5">
                            {/* Icon */}
                            <div className="flex h-[38px] w-[38px] items-center justify-center rounded-element bg-overlay-medium">
                                <AlertCircle className="h-5 w-5 text-content-primary" />
                            </div>

                            {/* Title and Description */}
                            <div className="flex flex-col items-center gap-2 text-center">
                                <h2 className="text-heading-xs text-content-primary">
                                    File not found
                                </h2>
                                <p className="text-paragraph-xs text-content-secondary">
                                    This file may have expired or been deleted.
                                </p>
                            </div>

                            {/* Action */}
                            <Button className="w-full" onClick={() => navigate('/')}>
                                Upload a new file
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Error state
    if (state === 'error') {
        return (
            <div className="pt-24 pb-16 px-6">
                <div className="max-w-main-card mx-auto">
                    <div className="card-glass p-card shadow-card">
                        <div className="relative z-10 flex flex-col items-center gap-5">
                            {/* Icon */}
                            <div className="flex h-[38px] w-[38px] items-center justify-center rounded-element bg-red-500/20">
                                <AlertCircle className="h-5 w-5 text-red-400" />
                            </div>

                            {/* Title and Description */}
                            <div className="flex flex-col items-center gap-2 text-center">
                                <h2 className="text-heading-xs text-content-primary">
                                    Download failed
                                </h2>
                                <p className="text-paragraph-xs text-content-secondary">
                                    {error || 'An error occurred while downloading the file.'}
                                </p>
                            </div>

                            {/* Actions */}
                            <div className="w-full flex flex-col gap-3">
                                <Button className="w-full" onClick={() => setState('ready')}>
                                    Try again
                                </Button>
                                <Button
                                    variant="outline"
                                    className="w-full"
                                    onClick={() => navigate('/')}
                                >
                                    Upload a new file
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Complete state
    if (state === 'complete') {
        return (
            <div className="pt-24 pb-16 px-6">
                <div className="max-w-main-card mx-auto">
                    <div className="card-glass p-card shadow-card">
                        <div className="relative z-10 flex flex-col items-center gap-5">
                            {/* Icon */}
                            <div className="flex h-[38px] w-[38px] items-center justify-center rounded-element bg-green-500/20">
                                <CheckCircle2 className="h-5 w-5 text-green-400" />
                            </div>

                            {/* Title and Description */}
                            <div className="flex flex-col items-center gap-2 text-center">
                                <h2 className="text-heading-xs text-content-primary">
                                    Download complete!
                                </h2>
                                <p className="text-paragraph-xs text-content-secondary">
                                    {canDownloadAgain
                                        ? 'Your file has been downloaded successfully.'
                                        : 'Your file has been downloaded. Download limit reached.'}
                                </p>
                            </div>

                            {/* Actions */}
                            <div className="w-full flex flex-col gap-3">
                                {canDownloadAgain && (
                                    <Button className="w-full" onClick={handleDownload}>
                                        Download again
                                    </Button>
                                )}
                                <Button
                                    variant={canDownloadAgain ? 'outline' : 'default'}
                                    className="w-full"
                                    onClick={() => navigate('/')}
                                >
                                    Upload a new file
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Ready state (default) and Downloading state
    return (
        <div className="pt-24 pb-16 px-6">
            <div className="max-w-main-card mx-auto">
                <div className="card-glass p-card shadow-card">
                    <div className="relative z-10 flex flex-col items-center gap-5">
                        {/* Icon */}
                        <div className="flex h-[38px] w-[38px] items-center justify-center rounded-element bg-overlay-medium">
                            <Download className="h-5 w-5 text-content-primary" />
                        </div>

                        {/* Title and Description */}
                        <div className="flex flex-col items-center gap-2 text-center">
                            <h2 className="text-heading-xs text-content-primary">Download files</h2>
                            <p className="text-paragraph-xs text-content-secondary">
                                This file was shared securely via Slingshot Send.
                            </p>
                        </div>

                        {/* Encrypted Badge */}
                        {metadata?.encrypted && (
                            <div className="flex items-center gap-2 bg-overlay-subtle border border-border-medium rounded-element px-3 py-2">
                                <Lock className="h-4 w-4 text-content-primary" />
                                <span className="text-paragraph-xs text-content-primary">
                                    End-to-end encrypted
                                </span>
                            </div>
                        )}

                        {/* File Info */}
                        {metadata?.files && metadata.files.length > 1 ? (
                            // Multiple files view
                            <div className="w-full space-y-3">
                                {/* Summary */}
                                <div className="bg-overlay-subtle border border-border-medium rounded-element p-3">
                                    <div className="flex items-center gap-[10px]">
                                        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded bg-overlay-medium">
                                            <Archive className="h-5 w-5 text-content-primary" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-paragraph-sm text-content-primary font-medium">
                                                {metadata.files.length} files
                                            </p>
                                            <p className="text-paragraph-xs text-content-tertiary">
                                                {formatBytes(
                                                    metadata.files.reduce(
                                                        (sum, f) => sum + f.size,
                                                        0,
                                                    ),
                                                )}{' '}
                                                total &middot; will download as .zip
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                {/* Individual files list */}
                                <div className="bg-overlay-subtle border border-border-medium rounded-element p-2 max-h-[200px] overflow-y-auto">
                                    <DownloadFileTree files={metadata.files} />
                                </div>
                            </div>
                        ) : (
                            // Single file view
                            <div className="w-full bg-overlay-subtle border border-border-medium rounded-element p-3">
                                <div className="flex items-center gap-[10px]">
                                    <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded bg-overlay-medium">
                                        <FileIcon className="h-5 w-5 text-content-primary" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="truncate text-paragraph-sm text-content-primary font-medium">
                                            {metadata?.name}
                                        </p>
                                        <p className="text-paragraph-xs text-content-tertiary">
                                            {formatBytes(metadata?.size || 0)}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Download button or progress */}
                        {state === 'downloading' ? (
                            <div className="w-full space-y-3">
                                <Progress
                                    value={downloadPhase === 'downloading' ? progress : 100}
                                    className="h-2"
                                />
                                <p className="text-center text-paragraph-xs text-content-secondary">
                                    {downloadPhase === 'decrypting'
                                        ? 'Decrypting...'
                                        : downloadPhase === 'finalizing'
                                          ? 'Finalizing...'
                                          : `Downloading... ${Math.round(progress)}%`}
                                </p>
                            </div>
                        ) : (
                            <Button className="w-full" onClick={handleDownload}>
                                Download
                            </Button>
                        )}

                        {/* Download limit and expiration notice */}
                        <p className="text-paragraph-xs text-content-tertiary text-center">
                            {downloadsLeft !== null && (
                                <>
                                    {downloadsLeft} download{downloadsLeft !== 1 ? 's' : ''} left ·{' '}
                                </>
                            )}
                            Expires in {metadata?.ttl ? formatTimeLimit(metadata.ttl) : '7 days'}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
