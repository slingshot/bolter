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
import { useNavigate, useParams } from 'react-router-dom';
import { DownloadFileTree } from '@/components/DownloadFileTree';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useDocumentMeta } from '@/hooks/useDocumentMeta';
import {
    API_BASE_URL,
    checkLegacyFile,
    type DownloadPhase,
    type DownloadStatusResult,
    downloadFile,
    fileExists,
    getDownloadStatus,
    getMetadata,
} from '@/lib/api';
import { Keychain } from '@/lib/crypto';
import { trackDownload } from '@/lib/plausible';
import { addBreadcrumb, captureError } from '@/lib/sentry';
import { captureUrlFragmentSecret } from '@/lib/url-secret';
import { formatBytes, formatTimeLimit, triggerDownload } from '@/lib/utils';

type DownloadState = 'loading' | 'ready' | 'downloading' | 'complete' | 'error' | 'not-found';

/**
 * The key never survives a reload: it is stripped from the address bar on load
 * and held in memory only (persisting it would put the file key on disk). Say
 * so, instead of leaving the user with a generic "missing key" message.
 */
const MISSING_KEY_MESSAGE =
    'This page is missing its decryption key. The key is the part of the link after "#", and it is removed from the address bar as soon as the page loads — so reloading or bookmarking this page loses it. Open the original share link again.';

const DIRECT_DOWNLOAD_SETTLE_MS = 3000;
const DIRECT_DOWNLOAD_RECHECK_MS = 2000;
const DIRECT_DOWNLOAD_STATUS_ATTEMPTS = 3;

export type DirectDownloadOutcome = 'delivered' | 'not-delivered' | 'unknown';

/**
 * Decide whether a hidden-iframe direct download actually delivered anything.
 *
 * The iframe cannot surface HTTP status, so the only observable signal is the
 * server-side download counter moving. `gone` means the file disappeared
 * during the attempt: that is only consistent with success when this very
 * download would have exhausted the limit (the server schedules deletion once
 * `dl >= dlimit`); otherwise it was deleted or expired out from under us and
 * nothing was delivered. A transient status error tells us nothing, so it
 * stays `unknown` and is treated as before (the page deliberately never turns
 * a transient status failure into a hard error).
 */
export function evaluateDirectDownloadOutcome(
    before: { dl: number; dlimit: number },
    after: DownloadStatusResult,
): DirectDownloadOutcome {
    if (after.status === 'ok') {
        return after.dl > before.dl ? 'delivered' : 'not-delivered';
    }
    if (after.status === 'gone') {
        return before.dl + 1 >= before.dlimit ? 'delivered' : 'not-delivered';
    }
    return 'unknown';
}

/**
 * Classify a download failure so expected conditions get the right screen.
 *
 * `limit` covers both the typed error a future `fetchDownloadUrlInfo` throws
 * at the download limit and the raw `HTTP 404`/`HTTP 410` the download routes
 * return once the file is exhausted or deleted — neither is a bug worth an
 * error report, and neither is fixed by a "Try again" button.
 */
export function classifyDownloadError(err: unknown): 'key' | 'limit' | 'other' {
    const name = err instanceof Error ? err.name : '';
    if (name === 'MissingKeyError' || name === 'InvalidKeyError') {
        return 'key';
    }
    const message = err instanceof Error ? err.message : String(err);
    if (name === 'LimitReachedError' || /HTTP (404|410)/.test(message)) {
        return 'limit';
    }
    return 'other';
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const navigate = useNavigate();

    // The AES key rides in the URL fragment. Read it out of memory (main.tsx
    // captured and stripped it before any telemetry SDK could read
    // location.href) and, for an in-app navigation that carried one, capture
    // and strip it here — during render, ahead of every effect, breadcrumb and
    // network call. The call is idempotent, so StrictMode double-renders and
    // ordinary re-renders are safe.
    const secretKey = captureUrlFragmentSecret();

    const [state, setState] = useState<DownloadState>('loading');
    const [metadata, setMetadata] = useState<FileMetadata | null>(null);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [keychain, setKeychain] = useState<Keychain | null>(null);
    const [canDownloadAgain, setCanDownloadAgain] = useState(true);
    const [downloadsLeft, setDownloadsLeft] = useState<number | null>(null);
    const [downloadPhase, setDownloadPhase] = useState<DownloadPhase>('downloading');
    const [isKeyError, setIsKeyError] = useState(false);
    const loadedKeyRef = useRef<string | null>(null);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const directPendingRef = useRef(false);
    const directRunRef = useRef(0);

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
                isMultiFile
                    ? (metadata.files?.reduce((sum, f) => sum + f.size, 0) ?? 0)
                    : metadata.size,
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

    // Keep the download iframe attached until the page unmounts — removing it
    // early cancels slow redirects after the server has already counted the download
    useEffect(() => {
        return () => {
            iframeRef.current?.remove();
            iframeRef.current = null;
        };
    }, []);

    // Extract secret key from URL hash
    useEffect(() => {
        if (!id) {
            setState('not-found');
            return;
        }
        const fileId = id;
        const requestKey = `${fileId}#${secretKey}`;

        // Prevent duplicate requests from StrictMode double-render
        if (loadedKeyRef.current === requestKey) {
            return;
        }
        const keyChanged = loadedKeyRef.current !== null;
        loadedKeyRef.current = requestKey;

        if (keyChanged) {
            setState('loading');
            setMetadata(null);
            setKeychain(null);
            setDownloadsLeft(null);
            setError(null);
            setIsKeyError(false);
            setProgress(0);
            setCanDownloadAgain(true);
        }

        // A newer navigation replaces loadedKeyRef, so a slow response for an
        // older key must not commit state (StrictMode re-runs keep the same key)
        const isStale = () => loadedKeyRef.current !== requestKey;

        async function loadMetadata() {
            try {
                // Check if file exists
                const exists = await fileExists(fileId);
                if (isStale()) {
                    return;
                }
                if (!exists) {
                    // Check legacy system before showing not found
                    const legacyUrl = await checkLegacyFile(fileId);
                    if (isStale()) {
                        return;
                    }
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

                // Check if download limit already reached; a transient status
                // error must not block loading — getMetadata decides then
                const status = await getDownloadStatus(fileId, kc);
                if (isStale()) {
                    return;
                }
                if (status.status === 'gone') {
                    setState('not-found');
                    return;
                }
                if (status.status === 'ok') {
                    if (status.dl >= status.dlimit) {
                        setState('not-found');
                        return;
                    }
                    setDownloadsLeft(status.dlimit - status.dl);
                }

                // Fetch metadata
                const meta = await getMetadata(fileId, kc || undefined);
                if (isStale()) {
                    return;
                }
                setMetadata(meta as FileMetadata);
                setState('ready');
            } catch (e: unknown) {
                if (isStale()) {
                    return;
                }
                const message = e instanceof Error ? e.message : String(e);
                console.error('Failed to load metadata:', e);
                if (
                    e instanceof Error &&
                    (e.name === 'MissingKeyError' || e.name === 'InvalidKeyError')
                ) {
                    setError(e.name === 'MissingKeyError' ? MISSING_KEY_MESSAGE : e.message);
                    setIsKeyError(true);
                    setState('error');
                } else if (message.includes('404') || message.includes('401')) {
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
    }, [id, secretKey]);

    const handleDownload = async () => {
        if (!id) {
            return;
        }

        // Continuations below outlive user navigation; snapshot the page key
        // so a finished download for file A never writes state onto file B
        const requestKey = loadedKeyRef.current;
        const isStale = () => loadedKeyRef.current !== requestKey;
        const fromCompleteScreen = state === 'complete';

        // Direct download for unencrypted files (uses native browser download)
        // Works for: single files, or multi-file zips (zipped at upload time)
        const canDirectDownload =
            metadata &&
            !metadata.encrypted &&
            (metadata.zipped || !metadata.files || metadata.files.length <= 1);

        if (canDirectDownload) {
            // A second click while the iframe navigation is committing would
            // abort the first request after the server already counted it
            if (directPendingRef.current) {
                return;
            }
            directPendingRef.current = true;
            // A later click supersedes any still-running delivery check
            const run = ++directRunRef.current;

            // Validate before navigating the iframe — the iframe itself cannot
            // surface server errors, so a failed pre-check must not burn a click
            const status = await getDownloadStatus(id, keychain);
            if (isStale()) {
                directPendingRef.current = false;
                return;
            }
            if (
                status.status === 'gone' ||
                (status.status === 'ok' && status.dl >= status.dlimit)
            ) {
                directPendingRef.current = false;
                if (fromCompleteScreen) {
                    // The file was already delivered to this user — show the
                    // limit-reached copy instead of replacing it with "not found"
                    setCanDownloadAgain(false);
                    setDownloadsLeft(0);
                } else {
                    setState('not-found');
                }
                return;
            }
            if (status.status === 'error') {
                directPendingRef.current = false;
                setIsKeyError(false);
                setError(
                    'Could not reach the server to start the download. Check your connection and try again.',
                );
                setState('error');
                return;
            }

            // Use hidden iframe to trigger download without leaving the page;
            // reuse a single iframe across clicks and keep it attached until
            // unmount so slow redirects are not cancelled mid-flight
            let iframe = iframeRef.current;
            if (!iframe) {
                iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                document.body.appendChild(iframe);
                iframeRef.current = iframe;
            }
            // Snapshot the counter so the post-navigation check can tell a real
            // delivery from an iframe request the server refused
            const before = { dl: status.dl, dlimit: status.dlimit };

            iframe.src = `${API_BASE_URL}/download/direct/${id}`;

            // Refresh download counts once the server has likely burned the credit
            setTimeout(async () => {
                directPendingRef.current = false;
                trackDownload({ fileId: id });
                if (isStale() || directRunRef.current !== run) {
                    return;
                }

                // The iframe cannot report HTTP failures (410 at the limit, a
                // 5xx from URL signing), so confirm delivery by watching the
                // server-side counter instead of assuming success. Re-check a
                // couple of times before giving up — a slow request may not
                // have reached the server yet.
                let after = await getDownloadStatus(id, keychain);
                for (
                    let attempt = 1;
                    attempt < DIRECT_DOWNLOAD_STATUS_ATTEMPTS &&
                    evaluateDirectDownloadOutcome(before, after) === 'not-delivered';
                    attempt++
                ) {
                    await delay(DIRECT_DOWNLOAD_RECHECK_MS);
                    if (isStale() || directRunRef.current !== run) {
                        return;
                    }
                    after = await getDownloadStatus(id, keychain);
                }
                if (isStale() || directRunRef.current !== run) {
                    return;
                }

                if (after.status === 'ok') {
                    setDownloadsLeft(after.dlimit - after.dl);
                    setCanDownloadAgain(after.dl < after.dlimit);
                } else if (after.status === 'gone') {
                    setCanDownloadAgain(false);
                }

                if (evaluateDirectDownloadOutcome(before, after) === 'not-delivered') {
                    captureError(new Error('Direct download delivered nothing'), {
                        operation: 'download.direct',
                        level: 'warning',
                        extra: {
                            fileId: id,
                            dlBefore: before.dl,
                            dlimit: before.dlimit,
                            afterStatus: after.status,
                        },
                    });
                    setIsKeyError(false);
                    setError(
                        'The download did not start. The file may have just reached its download limit, or the server rejected the request.',
                    );
                    setState('error');
                    return;
                }

                // 'unknown' (transient status error) is reported as before —
                // the page deliberately never turns a transient status failure
                // into a hard error
                setState('complete');
            }, DIRECT_DOWNLOAD_SETTLE_MS);
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

            // Trigger browser download — the file is delivered even if the
            // user has navigated to a different download page meanwhile
            triggerDownload(result.blob, result.filename);
            trackDownload({ fileId: id });
            if (isStale()) {
                return;
            }

            // Check download count vs limit to determine if more downloads available;
            // a transient status error must not claim the limit was reached
            const status = await getDownloadStatus(id, keychain);
            if (isStale()) {
                return;
            }
            if (status.status === 'ok') {
                setCanDownloadAgain(status.dl < status.dlimit);
                setDownloadsLeft(status.dlimit - status.dl);
            } else if (status.status === 'gone') {
                setCanDownloadAgain(false);
            }
            setState('complete');
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error('Download failed:', e);
            const kind = classifyDownloadError(e);
            if (kind === 'key') {
                if (!isStale()) {
                    setError(
                        e instanceof Error && e.name === 'MissingKeyError'
                            ? MISSING_KEY_MESSAGE
                            : message,
                    );
                    setIsKeyError(true);
                    setState('error');
                }
                return;
            }
            if (kind === 'limit') {
                // Expected: the file hit its download limit or was deleted
                // while this page was open. Show the limit / not-found screen
                // instead of a generic failure with a dead "Try again", and
                // don't report an expected condition as an error.
                if (!isStale()) {
                    setDownloadsLeft(0);
                    setCanDownloadAgain(false);
                    setState(fromCompleteScreen ? 'complete' : 'not-found');
                }
                return;
            }
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
            if (!isStale()) {
                setIsKeyError(false);
                setError(message);
                setState('error');
            }
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

                            {/* Actions — retrying cannot fix a missing/invalid key */}
                            <div className="w-full flex flex-col gap-3">
                                {!isKeyError && (
                                    <Button className="w-full" onClick={() => setState('ready')}>
                                        Try again
                                    </Button>
                                )}
                                <Button
                                    variant={isKeyError ? 'default' : 'outline'}
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
    // progress can briefly be NaN when the total is unknown (0)
    const hasProgress = Number.isFinite(progress);
    const clampedProgress = hasProgress ? Math.min(100, Math.max(0, Math.round(progress))) : 0;

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
                                    value={downloadPhase === 'downloading' ? clampedProgress : 100}
                                    className="h-2"
                                />
                                <p className="text-center text-paragraph-xs text-content-secondary">
                                    {downloadPhase === 'decrypting'
                                        ? 'Decrypting...'
                                        : downloadPhase === 'finalizing'
                                          ? 'Finalizing...'
                                          : hasProgress
                                            ? `Downloading... ${clampedProgress}%`
                                            : 'Downloading...'}
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
                            {/* Redis reports -1/-2 for keys without a TTL */}
                            Expires in{' '}
                            {metadata && metadata.ttl > 0
                                ? formatTimeLimit(metadata.ttl)
                                : '7 days'}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
