/**
 * API utilities for file upload and download
 * Implements resilient direct-to-cloudflare multipart uploads
 */

import {
    arrayToB64,
    b64ToArray,
    calculateEncryptedSize,
    createDecryptionStream,
    createEncryptionStream,
    ECE_ENCRYPTED_RECORD_SIZE,
    ECE_RECORD_SIZE,
    ECE_VERSION,
    Keychain,
    readEceVersion,
} from '@bolter/protocol/crypto';
import { getConcurrentUploads, isRetryableError, retryDelayMs } from '@bolter/protocol/retry';
import { UPLOAD_LIMITS } from '@bolter/shared';
import { predictLength } from 'client-zip';
import { FileReadError, LimitReachedError } from './errors';
import { addBreadcrumb, captureError } from './sentry';
import {
    createDownloadWriter,
    type DownloadWriter,
    type DownloadWriterOptions,
    savedToDiskPlaceholder,
} from './stream-saver';
import {
    getEngineLease,
    hasEngineLease,
    probeEligibility,
    recordEngineFallback,
    resumeEngineUploadInWorker,
    runEngineInWorker,
} from './upload-engine/client';
import { createEngineProgressReporter } from './upload-engine/progress-reporter';
import type { EngineJob, EngineSource } from './upload-engine/protocol';
import { type CompletionEnvelope, openEngineState } from './upload-engine/state';
import { withUploadLifecycle } from './upload-lifecycle';
import {
    computeContentFingerprint,
    deleteUploadState,
    discardUploadState,
    type PersistedUpload,
    saveUploadState,
    updateCompletedPart,
} from './upload-state';
import {
    createNameDeduplicator,
    createStreamingZip,
    createZipFromUploadFiles,
    createZipStreamFromConcatenated,
    type FileInfo,
    generateZipFilename,
    type StreamingZip,
} from './zip';

export { FileReadError } from './errors';
// Re-exported for the persisted-handle one-click resume flow [R13]: callers
// verify a handle-reacquired file with the same sampled fingerprint the
// legacy resume uses (`verifyHandleFile` in upload-engine/resume.ts).
export { computeContentFingerprint } from './upload-state';

// Threshold for using streaming zip (500MB) - below this, buffered zip is fine
const STREAMING_ZIP_THRESHOLD = 500 * 1024 * 1024;

// API base URL - defaults to localhost for development
export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Retry configuration (backoff base/cap live in @bolter/protocol/retry → retryDelayMs)
const MAX_RETRIES = 10;
const STALL_TIMEOUT = 60_000; // Abort upload part if no progress for 60 seconds

// Download retry configuration
const DOWNLOAD_MAX_RETRIES = 5;
const DOWNLOAD_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
const DOWNLOAD_STALL_TIMEOUT = 60_000; // Abort download attempt if no bytes for 60 seconds

/**
 * Wait until the browser reports connectivity again.
 *
 * Races the `online` event against cancellation: without that, cancelling while
 * offline leaves the retry awaiting an event that may never arrive, so
 * `allDonePromise` never resolves, `uploadFiles` never settles and the UI stays
 * stuck in "uploading" with no server-side cleanup.
 */
function waitForOnline(canceller?: Canceller): Promise<void> {
    if (navigator.onLine || canceller?.cancelled) {
        return Promise.resolve();
    }
    console.log('[Upload] Offline — waiting for connection...');
    return new Promise((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            window.removeEventListener('online', finish);
            unsubscribe?.();
            resolve();
        };
        window.addEventListener('online', finish);
        unsubscribe = canceller?.onCancel(finish);
    });
}

/**
 * Sleep that resolves early when the upload is cancelled, so a cancel during a
 * retry backoff doesn't leave the UI frozen for up to MAX_RETRY_DELAY.
 */
function cancellableDelay(ms: number, canceller?: Canceller): Promise<void> {
    if (canceller?.cancelled) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            unsubscribe?.();
            resolve();
        };
        const timer = setTimeout(finish, ms);
        unsubscribe = canceller?.onCancel(finish);
    });
}

// WebKit/Safari detection — used for iOS HEIC/HEVC transcoding workaround
const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

/**
 * Upload multipart parts using file.slice() instead of file.stream().
 *
 * Why: Safari/WebKit's ReadableStream has multiple bugs that make file.stream()
 * unreliable — empty Uint8Array(0) chunks, NotReadableError for files >4GB
 * (WebKit bug #272600), and a 60-second timeout on iOS (WebKit bug #228683).
 *
 * file.slice() is universally reliable: it creates lightweight byte-range
 * references without copying data into memory. Safari can send Blob slices
 * directly via XHR.
 *
 * Note: On some iOS versions, media files (HEVC, HEIC) may be lazily transcoded,
 * causing File.size to differ from actual content bytes. This can result in
 * truncated part uploads. The pre-completion consistency check below detects
 * this and fails early with a clear error rather than hitting R2's EntityTooSmall.
 */
async function uploadMultipartSliced(
    file: Blob,
    uploadInfo: UploadUrlResponse,
    onProgress: (partNum: number, loaded: number) => void,
    canceller: Canceller,
    onError?: (error: UploadError) => void,
    onRetry?: () => void,
    fileId?: string,
): Promise<{ parts: { PartNumber: number; ETag: string }[]; actualSize: number }> {
    const { parts, partSize } = uploadInfo;
    if (!parts || !partSize) {
        throw new Error('Invalid upload info');
    }

    const MIN_PART = UPLOAD_LIMITS.MIN_PART_SIZE;
    const maxConcurrent = getConcurrentUploads(file.size);
    console.log(
        `[Upload] Safari slice-based upload: ${parts.length} parts, ${partSize / (1024 * 1024)}MB each, file=${(file.size / (1024 * 1024)).toFixed(1)}MB, concurrency: ${maxConcurrent}`,
    );

    const completedParts: { PartNumber: number; ETag: string }[] = [];
    const failedPartNumbers: number[] = [];
    const partErrors: Record<number, { error: string; size: number }> = {};
    let activeUploads = 0;

    // Track actual bytes sent per part (from XHR progress) to detect truncated
    // uploads caused by iOS transcoding changing file size after slicing
    const uploadedPartSizes: Record<number, number> = {};

    // Process parts with concurrency control
    const pendingQueue: Array<{
        blob: Blob;
        partNum: number;
        url: string;
    }> = [];

    let resolveAllDone!: () => void;
    const allDonePromise = new Promise<void>((resolve) => {
        resolveAllDone = resolve;
    });
    let totalPartsFinished = 0;
    // Counted per part actually pushed, not `parts.length`: a skipped empty
    // slice would otherwise leave finished permanently below queued and
    // `allDonePromise` would never resolve (deadlock with no error).
    let totalPartsQueued = 0;
    let queueSealed = false;
    // First permanent part failure. The upload can no longer complete, so every
    // remaining part is wasted bandwidth — stop starting new ones.
    let fatalPartError: Error | null = null;

    const markPartFinished = (): void => {
        totalPartsFinished++;
        if (queueSealed && totalPartsFinished >= totalPartsQueued) {
            resolveAllDone();
        }
    };

    // Drop every not-yet-started part, still counting it as finished so the
    // completion promise resolves and uploadFiles actually settles.
    const drainPendingQueue = (): void => {
        while (pendingQueue.length > 0) {
            pendingQueue.shift();
            markPartFinished();
        }
    };

    const processQueue = (): void => {
        if (canceller.cancelled || fatalPartError) {
            drainPendingQueue();
            return;
        }
        while (pendingQueue.length > 0 && activeUploads < maxConcurrent) {
            const item = pendingQueue.shift();
            if (!item) {
                break;
            }
            activeUploads++;
            doUploadPart(item.blob, item.partNum, item.url);
        }
    };

    const doUploadPart = async (
        partBlob: Blob,
        partNum: number,
        partUrl: string,
    ): Promise<void> => {
        try {
            if (canceller.cancelled) {
                throw new Error('Upload cancelled');
            }
            const result = await uploadPartWithRetry(
                partBlob,
                partUrl,
                partNum,
                (loaded) => onProgress(partNum, loaded),
                canceller,
                0,
                onRetry,
            );
            completedParts.push(result);
            uploadedPartSizes[partNum] = result.bytesSent;

            // Warn if actual bytes sent differ from expected blob size
            if (result.bytesSent !== partBlob.size) {
                console.warn(
                    `[Upload] Part ${partNum} size mismatch: blob.size=${partBlob.size}, bytesSent=${result.bytesSent} (iOS transcoding?)`,
                );
                captureError(
                    new Error(
                        `Slice-based part size mismatch: part ${partNum} blob.size=${partBlob.size}, bytesSent=${result.bytesSent}`,
                    ),
                    {
                        operation: 'upload.part.size-mismatch',
                        extra: {
                            partNumber: partNum,
                            blobSize: partBlob.size,
                            bytesSent: result.bytesSent,
                            fileSize: file.size,
                            totalParts: parts.length,
                        },
                        level: 'warning',
                    },
                );
            }

            if (fileId) {
                updateCompletedPart(fileId, result).catch((e) =>
                    console.warn('[Upload] Failed to persist completed part:', e),
                );
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[Upload] Part ${partNum} failed:`, message);
            captureError(error, {
                operation: 'upload.part.sliced',
                extra: { partNumber: partNum, partSize: partBlob.size, totalParts: parts.length },
                level: 'warning',
            });
            partErrors[partNum] = { error: message, size: partBlob.size };
            failedPartNumbers.push(partNum);
            if (!canceller.cancelled && !fatalPartError) {
                fatalPartError = error instanceof Error ? error : new Error(message);
            }
        } finally {
            activeUploads--;
            markPartFinished();
            processQueue();
        }
    };

    // Slice the file into parts and queue them
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const start = i * partSize;
        const end = Math.min(start + partSize, file.size);
        const partBlob = file.slice(start, end);

        // Skip empty slices (shouldn't happen, but defensive)
        if (partBlob.size === 0) {
            console.warn(`[Upload] Skipping empty slice for part ${part.partNumber}`);
            captureError(new Error(`Skipped empty slice for part ${part.partNumber}`), {
                operation: 'upload.empty-slice.sliced',
                extra: {
                    partNumber: part.partNumber,
                    partSize,
                    fileSize: file.size,
                    totalParts: parts.length,
                },
                level: 'warning',
            });
            continue;
        }

        totalPartsQueued++;
        pendingQueue.push({ blob: partBlob, partNum: part.partNumber, url: part.url });
    }

    // No more parts will be added — resolveAllDone() may now fire.
    queueSealed = true;

    processQueue();

    if (totalPartsQueued > 0 && totalPartsFinished < totalPartsQueued) {
        await allDonePromise;
    }

    if (canceller.cancelled) {
        throw new Error('Upload cancelled');
    }

    if (failedPartNumbers.length > 0) {
        const error: UploadError = {
            message: `Failed to upload ${failedPartNumbers.length} parts: ${failedPartNumbers.join(', ')}`,
            failedParts: failedPartNumbers,
            partErrors,
            retryable: true,
        };
        onError?.(error);
        throw new Error(error.message);
    }

    console.log(`[Upload] All ${completedParts.length} parts completed (slice-based)`);

    // Pre-completion consistency check: verify non-trailing parts meet R2's 5MB minimum.
    // On iOS Safari, file.slice() can produce truncated blobs when the actual file content
    // differs from File.size due to lazy media transcoding (HEVC→H.264, HEIC→JPEG).
    const sortedPartNums = Object.keys(uploadedPartSizes)
        .map(Number)
        .sort((a, b) => a - b);
    if (sortedPartNums.length > 1) {
        const maxPartNum = Math.max(...sortedPartNums);
        const undersizedParts = sortedPartNums
            .filter((pn) => pn !== maxPartNum && uploadedPartSizes[pn] < MIN_PART)
            .map((pn) => ({ partNumber: pn, size: uploadedPartSizes[pn] }));

        if (undersizedParts.length > 0) {
            const diagnostic = {
                undersizedParts,
                allPartSizes: uploadedPartSizes,
                uploadId: uploadInfo.uploadId,
                partSize,
                fileSize: file.size,
                totalParts: sortedPartNums.length,
            };
            console.error(
                '[Upload] CRITICAL: Non-trailing parts below 5MB minimum detected (slice-based)!',
                diagnostic,
            );
            captureError(
                new Error(
                    `Slice-based upload: ${undersizedParts.length} non-trailing parts below 5MB minimum: ${undersizedParts.map((p) => `part ${p.partNumber}=${p.size}`).join(', ')}`,
                ),
                {
                    operation: 'upload.part-size-consistency.sliced',
                    extra: {
                        undersizedParts: JSON.stringify(undersizedParts),
                        allPartSizes: JSON.stringify(uploadedPartSizes),
                        uploadId: uploadInfo.uploadId,
                        partSize,
                        fileSize: file.size,
                        totalParts: sortedPartNums.length,
                    },
                },
            );
            throw new Error(
                'Upload failed: some parts were truncated during upload (iOS media transcoding may have changed the file size). Please try again.',
            );
        }
    }

    return {
        parts: completedParts.sort((a, b) => a.PartNumber - b.PartNumber),
        actualSize: file.size,
    };
}

/**
 * Part size actually used when cutting the stream into parts.
 * Encrypted parts are cut on ECE record boundaries so every non-trailing part
 * holds a whole number of records — required for resume to re-encrypt the
 * remainder with a consistent record counter. The backend allocates parts
 * based on the raw partSize; since the effective size is <= partSize the last
 * allocated part absorbs the residual bytes.
 */
export function getEffectivePartSize(partSize: number, encrypted: boolean): number {
    if (!encrypted) {
        return partSize;
    }
    return Math.floor(partSize / ECE_ENCRYPTED_RECORD_SIZE) * ECE_ENCRYPTED_RECORD_SIZE;
}

export interface UploadProgress {
    loaded: number;
    total: number;
    percentage: number;
    speed: number; // bytes per second
    remainingTime: number; // seconds
    retryCount: number;
    isOffline: boolean;
    connectionQuality: 'good' | 'fair' | 'slow' | 'stalled' | 'offline';
}

export interface UploadResult {
    id: string;
    url: string;
    ownerToken: string;
    duration: number;
    /**
     * Authoritative expiry from `/upload/complete` (audit #15).
     *
     * The server starts the metadata TTL at `/upload/url`, not at completion,
     * so a long or resumed upload finishes with materially less lifetime left
     * than `timeLimit` suggests. These are the server's own numbers; absent
     * when talking to a backend that predates them, in which case callers fall
     * back to an estimate anchored at upload start.
     */
    expiresAt?: number;
    ttl?: number;
}

/** `/upload/complete` response fields this client consumes. */
export interface CompleteResponse {
    expiresAt?: number;
    ttl?: number;
}

/**
 * Read the authoritative lifetime from a `/upload/complete` response body,
 * tolerating an older backend that does not send it (audit #15).
 */
export async function readCompletionLifetime(response: Response): Promise<CompleteResponse> {
    try {
        const body = (await response.json()) as CompleteResponse | null;
        if (!body) {
            return {};
        }
        return {
            expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : undefined,
            ttl: typeof body.ttl === 'number' ? body.ttl : undefined,
        };
    } catch {
        // A completion that succeeded but returned an unreadable body must not
        // fail the upload — the object is already finalized.
        return {};
    }
}

export interface UploadOptions {
    files: File[];
    encrypted?: boolean;
    timeLimit?: number;
    downloadLimit?: number;
    onProgress?: (progress: UploadProgress) => void;
    onZipProgress?: (percent: number) => void;
    onError?: (error: UploadError) => void;
    /**
     * Positional (parallel to `files`): File System Access handles for entries
     * that have one (Chromium top-level drag-drop / `showOpenFilePicker`).
     * A single-file engine upload persists its handle with the lease so an
     * interrupted upload can offer one-click resume after reload [R13].
     */
    handles?: ReadonlyArray<FileSystemFileHandle | undefined>;
}

export interface UploadError {
    message: string;
    failedParts?: number[];
    partErrors?: Record<number, { error: string; size: number }>;
    retryable: boolean;
}

interface PartInfo {
    partNumber: number;
    url: string;
    minSize: number;
    maxSize: number;
}

interface UploadUrlResponse {
    useSignedUrl: boolean;
    multipart: boolean;
    id: string;
    owner: string;
    /** Bearer credential authorizing abort/resume of THIS upload (audit #52). */
    uploadToken?: string;
    uploadId?: string;
    parts?: PartInfo[];
    partSize?: number;
    url: string;
    completeUrl?: string;
}

export class Canceller {
    cancelled = false;
    private xhrs: XMLHttpRequest[] = [];
    private listeners: Array<() => void> = [];

    cancel() {
        this.cancelled = true;
        // Iterate a snapshot: xhr.abort() fires loadend synchronously, whose
        // handlers call removeXhr() and would mutate this.xhrs mid-iteration,
        // skipping every other in-flight request
        for (const xhr of [...this.xhrs]) {
            if (xhr.readyState !== XMLHttpRequest.DONE) {
                xhr.abort();
            }
        }
        // Wake anything parked on a non-XHR wait (offline wait, retry backoff).
        const listeners = [...this.listeners];
        this.listeners = [];
        for (const listener of listeners) {
            try {
                listener();
            } catch (e) {
                console.warn('[Upload] Cancel listener threw:', e);
            }
        }
    }

    /**
     * Register a callback fired once when the upload is cancelled. Returns an
     * unsubscribe function. Fires immediately if cancellation already happened,
     * so there is no window where a waiter can be registered too late.
     */
    onCancel(listener: () => void): () => void {
        if (this.cancelled) {
            listener();
            return () => {
                /* already fired */
            };
        }
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index > -1) {
                this.listeners.splice(index, 1);
            }
        };
    }

    addXhr(xhr: XMLHttpRequest) {
        this.xhrs.push(xhr);
    }

    removeXhr(xhr: XMLHttpRequest) {
        const index = this.xhrs.indexOf(xhr);
        if (index > -1) {
            this.xhrs.splice(index, 1);
        }
    }
}

/**
 * Get API configuration
 */
export async function getConfig() {
    const response = await fetchWithRetry(`${API_BASE_URL}/config`, {}, 3);
    if (!response.ok) {
        throw new Error('Failed to fetch config');
    }
    return response.json();
}

/**
 * Check if file exists
 */
export async function fileExists(id: string): Promise<boolean> {
    const response = await fetchWithRetry(`${API_BASE_URL}/exists/${id}`, {}, 3);
    if (!response.ok) {
        return false;
    }
    const data = await response.json();
    return data.exists;
}

/**
 * Check if file exists on legacy system
 * Returns redirect URL if file exists, null otherwise
 */
export async function checkLegacyFile(id: string): Promise<string | null> {
    try {
        const response = await fetch(`${API_BASE_URL}/download/legacy/${id}`);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return data.redirect;
    } catch {
        return null;
    }
}

/**
 * Get file metadata
 */
export async function getMetadata(id: string, keychain?: Keychain) {
    const headers: Record<string, string> = {};

    if (keychain) {
        headers.Authorization = await keychain.authHeader();
    }

    let response = await fetch(`${API_BASE_URL}/metadata/${id}`, { headers });

    // Handle 401 challenge-response: extract nonce and retry
    if (response.status === 401 && keychain) {
        const authHeader = response.headers.get('WWW-Authenticate');
        if (authHeader) {
            const nonce = authHeader.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
                headers.Authorization = await keychain.authHeader();
                response = await fetch(`${API_BASE_URL}/metadata/${id}`, { headers });
            }
        }
    }

    // Extract nonce for future requests
    const authHeader = response.headers.get('WWW-Authenticate');
    if (authHeader && keychain) {
        const nonce = authHeader.split(' ')[1];
        if (nonce) {
            keychain.nonce = nonce;
        }
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    // biome-ignore lint/suspicious/noImplicitAnyLet: metadata shape is dynamic (decrypted JSON or parsed base64)
    let metadata;

    if (data.encrypted !== false && !keychain) {
        const err = new Error(
            'This file is encrypted, but the link is missing its decryption key. Ask the sender for the complete link (including everything after #).',
        );
        err.name = 'MissingKeyError';
        throw err;
    }

    if (data.encrypted !== false && keychain) {
        // Encrypted metadata - decrypt it
        try {
            metadata = await keychain.decryptMetadata(b64ToArray(data.metadata));
        } catch (e) {
            console.error('[getMetadata] Decryption failed:', e);
            captureError(e, {
                operation: 'metadata.decrypt',
                extra: { fileId: id, metadataLength: data.metadata?.length },
            });
            const err = new Error(
                'The decryption key in this link is incorrect or incomplete. Ask the sender to re-copy the full link.',
            );
            err.name = 'InvalidKeyError';
            throw err;
        }
    } else {
        // Unencrypted metadata - decode from base64
        try {
            // Handle URL-safe base64 by converting to standard base64
            const standardB64 = data.metadata.replace(/-/g, '+').replace(/_/g, '/');
            // Add padding if needed
            const padded = standardB64 + '==='.slice(0, (4 - (standardB64.length % 4)) % 4);

            const decoded = atob(padded);
            try {
                // Try UTF-8 decoding first
                metadata = JSON.parse(decodeURIComponent(escape(decoded)));
            } catch {
                // Fallback to direct parse
                metadata = JSON.parse(decoded);
            }
        } catch (e) {
            console.error('[getMetadata] Decode failed:', e, 'metadata:', data.metadata);
            captureError(e, {
                operation: 'metadata.decode',
                extra: { fileId: id, metadataLength: data.metadata?.length },
            });
            throw e;
        }
    }

    // Extract first file info for convenience (UI expects name/size at root)
    const firstFile = metadata.files?.[0];

    return {
        ...metadata,
        name: firstFile?.name || metadata.name || 'download',
        size: firstFile?.size || metadata.size || 0,
        type: firstFile?.type || metadata.type || 'application/octet-stream',
        ttl: data.ttl,
        encrypted: data.encrypted !== false,
    };
}

/**
 * Delete a file
 */
export async function deleteFile(id: string, ownerToken: string): Promise<boolean> {
    const response = await fetch(`${API_BASE_URL}/delete/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner_token: ownerToken }),
    });
    return response.ok;
}

/**
 * Get file info (download count, limit, TTL) - requires owner token
 */
export type FileInfoResult =
    | { status: 'ok'; dl: number; dlimit: number; ttl: number }
    | { status: 'not_found' }
    | { status: 'error' };

export async function getFileInfo(id: string, ownerToken: string): Promise<FileInfoResult> {
    try {
        const response = await fetch(`${API_BASE_URL}/info/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner_token: ownerToken }),
        });
        if (response.status === 404) {
            return { status: 'not_found' };
        }
        if (!response.ok) {
            return { status: 'error' };
        }
        const data = await response.json();
        return { status: 'ok', ...data };
    } catch {
        // Network error — don't assume file is deleted
        return { status: 'error' };
    }
}

/**
 * Get download status (dl, dlimit).
 * Encrypted files require a keychain for authentication.
 * 'gone' means the file no longer exists (404/410); 'error' covers network
 * failures and other non-ok responses so the UI can distinguish transient
 * failures from an exhausted download limit.
 */
export type DownloadStatusResult =
    | { status: 'ok'; dl: number; dlimit: number }
    | { status: 'gone' }
    | { status: 'error' };

export async function getDownloadStatus(
    id: string,
    keychain?: Keychain | null,
): Promise<DownloadStatusResult> {
    try {
        const headers: Record<string, string> = {};
        if (keychain) {
            headers.Authorization = await keychain.authHeader();
        }

        let response = await fetch(`${API_BASE_URL}/download/url/${id}`, { headers });

        // Handle 401 challenge-response for encrypted files
        if (response.status === 401 && keychain) {
            const wwwAuth = response.headers.get('WWW-Authenticate');
            if (wwwAuth) {
                const nonce = wwwAuth.split(' ')[1];
                if (nonce) {
                    keychain.nonce = nonce;
                    headers.Authorization = await keychain.authHeader();
                    response = await fetch(`${API_BASE_URL}/download/url/${id}`, { headers });
                }
            }
        }

        // Harvest the rotated nonce from the final response (successful or not)
        if (keychain) {
            const wwwAuth = response.headers.get('WWW-Authenticate');
            const nonce = wwwAuth?.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
            }
        }

        if (response.status === 404 || response.status === 410) {
            return { status: 'gone' };
        }
        if (!response.ok) {
            return { status: 'error' };
        }
        const data = await response.json();
        return { status: 'ok', dl: data.dl, dlimit: data.dlimit };
    } catch {
        return { status: 'error' };
    }
}

/**
 * Upload files with resilient multipart support
 * Multi-file uploads are zipped at upload time for efficient downloads
 */
export function uploadFiles(
    options: UploadOptions,
    keychain: Keychain,
    canceller: Canceller,
): Promise<UploadResult> {
    // Lifecycle extras (screen wake lock, one-shot storage.persist()) wrap the
    // engine and legacy pipelines alike. The server fileId does not exist
    // until allocation happens mid-pipeline, so the lifecycle is keyed by a
    // per-attempt label instead.
    const attemptLabel = `up_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return withUploadLifecycle(attemptLabel, () =>
        uploadFilesPipeline(options, keychain, canceller),
    );
}

async function uploadFilesPipeline(
    options: UploadOptions,
    keychain: Keychain,
    canceller: Canceller,
): Promise<UploadResult> {
    const {
        files,
        encrypted = true,
        timeLimit,
        downloadLimit,
        onProgress,
        onZipProgress,
        onError,
    } = options;

    // Worker-engine delegation: multipart-sized uploads run through the
    // worker+OPFS engine when the environment supports it; everything else
    // falls through to the untouched legacy pipeline below. The gate mirrors
    // the legacy multipart gate but is evaluated on the declared input size —
    // this branch deliberately sits ahead of zip construction and
    // encryption-stream creation [R8], so the exact zipped size is not known
    // yet. It is a *pre-filter*: the engine re-applies the same gate on the
    // real post-zip size before spending anything, and declines back to here.
    const declaredInputSize = files.reduce((sum, f) => sum + f.size, 0);
    const engineGateSize = encrypted
        ? calculateEncryptedSize(declaredInputSize)
        : declaredInputSize;
    let engineHandoff: EngineDeclineHandoff | undefined;
    if (engineGateSize > UPLOAD_LIMITS.MULTIPART_THRESHOLD) {
        const eligibility = await probeEligibility();
        if (eligibility.eligible) {
            const handoff: EngineDeclineHandoff = {};
            const engineResult = await uploadFilesViaEngine(options, keychain, canceller, handoff);
            if (engineResult) {
                return engineResult;
            }
            engineHandoff = handoff;
        } else {
            console.log(
                `[Upload] Engine ineligible (${eligibility.reason ?? 'unknown'}) — using legacy pipeline`,
            );
        }
    }

    const startTime = Date.now();
    let lastProgressTime = startTime;
    let lastProgressBytes = 0;
    let lastDisplayTime = startTime;
    let smoothedSpeed = 0;
    let smoothedRemaining = 0;
    let totalRetryCount = 0;
    let lastPartProgressTime = Date.now();

    // Determine upload strategy for multi-file uploads
    const isMultiFile = files.length > 1;
    const totalInputSize = files.reduce((sum, f) => sum + f.size, 0);
    // Streaming zip (STORE, no compression) uses constant memory.
    // Buffered zip (DEFLATE) loads all data + JSZip buffers + output = ~3-4x input size.
    // On iOS Safari, the jetsam OOM limit is ~1.5GB, so buffered zip is only safe
    // for inputs under ~200MB. Lower the threshold on WebKit accordingly.
    const streamingThreshold = isWebKit ? 100 * 1024 * 1024 : STREAMING_ZIP_THRESHOLD;
    const useStreamingZip = isMultiFile && totalInputSize >= streamingThreshold;

    // For multiple files, create a zip (buffered for small, streaming for large)
    let uploadBlob: Blob | null = null;
    let zipFilename: string | null = null;
    let streamingZipStream: ReadableStream<Uint8Array> | null = null;
    let estimatedZipSize = 0;
    // Retained (not destructured away) so the cancellation / terminal-failure
    // paths can call dispose() — nothing else reaches the per-file source
    // streams the zip is reading from.
    let streamingZip: StreamingZip | null = null;

    if (isMultiFile) {
        if (useStreamingZip) {
            // Large files: use streaming zip to avoid memory issues
            // Progress will be reported during upload as bytes are processed
            streamingZip = createStreamingZip(files, (processed, total) => {
                // Report zipping progress as percentage
                onZipProgress?.(Math.round((processed / total) * 100));
            });
            streamingZipStream = streamingZip.stream;
            zipFilename = streamingZip.filename;
            estimatedZipSize = streamingZip.estimatedSize;
        } else if (engineHandoff?.zip) {
            // A declined engine attempt already built this exact zip — same
            // files, same deduplicated names, same DEFLATE settings. Reusing
            // it skips a second compression pass over hundreds of megabytes,
            // and keeps the zip progress the user just watched reach 100%
            // from rewinding to 0.
            uploadBlob = engineHandoff.zip.blob;
            zipFilename = engineHandoff.zip.filename;
        } else {
            // Small files: use buffered zip for compression benefits and exact sizing
            const zipResult = await createZipFromUploadFiles(files, onZipProgress);
            uploadBlob = zipResult.blob;
            zipFilename = zipResult.filename;
            // Clear zipping progress now that we're done
            onZipProgress?.(100);
        }
    }

    // Calculate total size
    // For streaming zip: use estimated size (actual uncompressed + headers)
    // For buffered zip: use actual blob size
    // For single file: use file size (on iOS, File.size reflects transcoded size)
    let plainSize: number;
    if (streamingZipStream) {
        plainSize = estimatedZipSize;
    } else if (uploadBlob) {
        plainSize = uploadBlob.size;
    } else {
        plainSize = totalInputSize;
    }
    const totalSize = encrypted ? calculateEncryptedSize(plainSize) : plainSize;

    // Create metadata - keep original file info for display, mark as zipped if applicable
    const metadata: {
        files: { name: string; size: number; type: string }[];
        zipped?: boolean;
        zipFilename?: string;
        eceVersion?: number;
    } = {
        files: files.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type || 'application/octet-stream',
        })),
        // ECE format marker so the decryptor can fail closed on a missing
        // final record (truncation) instead of accepting it as legacy data.
        ...(encrypted && { eceVersion: ECE_VERSION }),
    };

    if (isMultiFile && zipFilename) {
        metadata.zipped = true;
        metadata.zipFilename = zipFilename;
    }

    // Create stream for stream-based upload path.
    // Safari single-file unencrypted uploads use the slice-based path instead (no stream needed).
    // - Streaming zip for large multi-file uploads (non-Safari)
    // - Blob stream for buffered zip or single blobs
    // - File stream for single files
    let stream: ReadableStream<Uint8Array>;
    if (streamingZipStream) {
        // Streaming zip - optionally encrypt
        stream = encrypted
            ? streamingZipStream.pipeThrough(createEncryptionStream(keychain))
            : streamingZipStream;
    } else if (uploadBlob) {
        stream = createBlobStream(uploadBlob, keychain, encrypted);
    } else {
        stream = createFileStream(files, keychain, encrypted);
    }

    // Everything below the zip construction must release the zip's per-file
    // source streams on failure. The main upload has a finally block for that;
    // this window (the URL request) sits ahead of it, and `stream` is already
    // being pumped by then, so it needs its own guard.
    let uploadInfo: UploadUrlResponse;
    try {
        // An upload can still be cancelled between zip construction and
        // allocation — otherwise the server-side multipart + metadata get
        // created for an upload nobody wants.
        if (canceller.cancelled) {
            throw new Error('Upload cancelled');
        }

        // Request upload URLs
        const uploadResponse = await fetch(`${API_BASE_URL}/upload/url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileSize: totalSize,
                encrypted,
                timeLimit,
                dlimit: downloadLimit,
            }),
        });

        if (!uploadResponse.ok) {
            throw new Error(`HTTP ${uploadResponse.status}`);
        }

        uploadInfo = await uploadResponse.json();

        if (!uploadInfo.useSignedUrl) {
            throw new Error('Pre-signed URLs not available');
        }
    } catch (e) {
        await streamingZip?.dispose();
        throw e;
    }

    // Track progress
    const partProgress: Record<number, number> = {};

    // Emit a progress snapshot to the UI
    const emitProgress = () => {
        const totalLoaded = Object.values(partProgress).reduce((sum, p) => sum + p, 0);
        const isOffline = !navigator.onLine;
        const now = Date.now();

        let connectionQuality: UploadProgress['connectionQuality'];
        if (isOffline) {
            connectionQuality = 'offline';
        } else if (smoothedSpeed === 0 || now - lastPartProgressTime > 10000) {
            connectionQuality = 'stalled';
        } else if (smoothedSpeed < 1 * 1024 * 1024) {
            connectionQuality = 'slow';
        } else if (smoothedSpeed < 10 * 1024 * 1024) {
            connectionQuality = 'fair';
        } else {
            connectionQuality = 'good';
        }

        onProgress?.({
            loaded: Math.min(totalLoaded, totalSize),
            total: totalSize,
            percentage: Math.min((totalLoaded / totalSize) * 100, 100),
            speed: smoothedSpeed,
            remainingTime: smoothedRemaining,
            retryCount: totalRetryCount,
            isOffline,
            connectionQuality,
        });
    };

    const updateProgress = (partNum: number, loaded: number) => {
        partProgress[partNum] = loaded;
        const totalLoaded = Object.values(partProgress).reduce((sum, p) => sum + p, 0);

        const now = Date.now();

        // When totalLoaded drops (part retry reset), re-baseline so
        // the next progress event doesn't produce a huge speed spike.
        if (totalLoaded < lastProgressBytes) {
            lastProgressBytes = totalLoaded;
            lastProgressTime = now;
        }

        const elapsed = (now - lastProgressTime) / 1000;
        const bytesInPeriod = totalLoaded - lastProgressBytes;
        // Clamp to zero: progress resets during retries can cause negative deltas
        const instantSpeed = elapsed > 0 ? Math.max(0, bytesInPeriod / elapsed) : 0;

        if (bytesInPeriod > 0) {
            lastPartProgressTime = now;
        }

        const displayElapsed = (now - lastDisplayTime) / 1000;
        if (displayElapsed >= 1 || lastDisplayTime === startTime) {
            smoothedSpeed =
                smoothedSpeed === 0 ? instantSpeed : smoothedSpeed * 0.7 + instantSpeed * 0.3;
            smoothedRemaining = smoothedSpeed > 0 ? (totalSize - totalLoaded) / smoothedSpeed : 0;
            lastDisplayTime = now;
            lastProgressTime = now;
            lastProgressBytes = totalLoaded;
        }

        emitProgress();
    };

    // Re-evaluate connection quality on connectivity changes and periodically
    // so offline/stalled states show immediately even when no bytes are flowing
    const statusPollInterval = setInterval(emitProgress, 1000);
    const onConnectivityChange = () => emitProgress();
    window.addEventListener('online', onConnectivityChange);
    window.addEventListener('offline', onConnectivityChange);

    // Progress regression detection — poll every 5s and report to Sentry if
    // total uploaded bytes drop below the previously observed high-water mark.
    // This catches unexpected progress resets that users see in the UI, whether
    // caused by part retries, stream bugs, or transcoding quirks.
    let progressHighWaterMark = 0;
    let regressionReported = false; // one report per upload to avoid spam
    const REGRESSION_CHECK_MS = 5_000;
    const regressionInterval = setInterval(() => {
        const currentLoaded = Object.values(partProgress).reduce((sum, p) => sum + p, 0);
        if (currentLoaded < progressHighWaterMark && !regressionReported) {
            regressionReported = true;
            const regressionBytes = progressHighWaterMark - currentLoaded;
            const now = Date.now();
            captureError(new Error('Upload progress regression detected'), {
                operation: 'upload.progress-regression',
                level: 'warning',
                extra: {
                    highWaterMark: progressHighWaterMark,
                    currentLoaded,
                    regressionBytes,
                    regressionPercent: Number(((regressionBytes / totalSize) * 100).toFixed(2)),
                    totalSize,
                    percentage: Number(((currentLoaded / totalSize) * 100).toFixed(2)),
                    activeParts: Object.keys(partProgress).length,
                    partProgressSnapshot: JSON.stringify(partProgress),
                    retryCount: totalRetryCount,
                    isOffline: !navigator.onLine,
                    smoothedSpeed,
                    elapsedSeconds: Number(((now - startTime) / 1000).toFixed(1)),
                    encrypted,
                    isMultiFile,
                    isMultipart: !!(uploadInfo.multipart && uploadInfo.parts),
                    partSize: uploadInfo.partSize ?? null,
                    totalParts: uploadInfo.parts?.length ?? 1,
                    userAgent: navigator.userAgent,
                },
                tags: {
                    encrypted: String(encrypted),
                    multipart: String(!!(uploadInfo.multipart && uploadInfo.parts)),
                    connectionQuality: navigator.onLine
                        ? smoothedSpeed === 0
                            ? 'stalled'
                            : smoothedSpeed < 1 * 1024 * 1024
                              ? 'slow'
                              : smoothedSpeed < 10 * 1024 * 1024
                                ? 'fair'
                                : 'good'
                        : 'offline',
                },
            });
            addBreadcrumb('Progress regression detected', {
                category: 'upload',
                level: 'warning',
                data: {
                    highWaterMark: progressHighWaterMark,
                    currentLoaded,
                    regressionBytes,
                    retryCount: totalRetryCount,
                },
            });
        }
        progressHighWaterMark = Math.max(progressHighWaterMark, currentLoaded);
    }, REGRESSION_CHECK_MS);

    const cleanupStatusPoll = () => {
        clearInterval(statusPollInterval);
        clearInterval(regressionInterval);
        window.removeEventListener('online', onConnectivityChange);
        window.removeEventListener('offline', onConnectivityChange);
    };

    let uploadResult: { actualSize: number; parts?: { PartNumber: number; ETag: string }[] };
    let uploadSucceeded = false;

    try {
        // A cancel that landed while /upload/url was in flight: the server-side
        // multipart and metadata now exist, so throw from inside the try and let
        // the finally abort them.
        if (canceller.cancelled) {
            throw new Error('Upload cancelled');
        }

        if (uploadInfo.multipart && uploadInfo.parts) {
            // Only persist resumability state for single-file uploads.
            // Multi-file uploads create a streaming zip that can't be
            // reconstructed from the original files on resume.
            const canResume = !isMultiFile;
            if (canResume) {
                // Calculate plaintext bytes per encrypted part. Encrypted parts are
                // cut on ECE record boundaries (see getEffectivePartSize), so each
                // non-trailing part holds exactly this many plaintext bytes.
                const plaintextPartSize = encrypted
                    ? (getEffectivePartSize(uploadInfo.partSize || 0, true) /
                          ECE_ENCRYPTED_RECORD_SIZE) *
                      ECE_RECORD_SIZE
                    : uploadInfo.partSize || 0;
                // Content fingerprint so a resume can prove the re-selected file
                // is the same file — (name, size, mtime) is not an identity and
                // a same-tuple different file would be spliced onto the prefix.
                let contentFingerprint: string | undefined;
                try {
                    contentFingerprint = await computeContentFingerprint(files[0]);
                } catch (e) {
                    console.warn('[Upload] Failed to fingerprint file for resume:', e);
                }

                const persistState: PersistedUpload = {
                    fileId: uploadInfo.id,
                    uploadId: uploadInfo.uploadId || '',
                    ownerToken: uploadInfo.owner,
                    uploadToken: uploadInfo.uploadToken,
                    fileName: files[0].name,
                    fileSize: files[0].size,
                    fileLastModified: files[0].lastModified,
                    contentFingerprint,
                    encrypted,
                    partSize: uploadInfo.partSize || 0,
                    plaintextPartSize,
                    completedParts: [],
                    totalParts: uploadInfo.parts.length,
                    secretKeyB64: encrypted ? keychain.secretKeyB64 : undefined,
                    timeLimit: timeLimit || 86400,
                    downloadLimit: downloadLimit || 1,
                    createdAt: Date.now(),
                };
                saveUploadState(persistState).catch((e) =>
                    console.warn('[Upload] Failed to persist upload state:', e),
                );
            }

            // Multipart upload — use slice-based path on Safari for unencrypted
            // single-file uploads (avoids WebKit ReadableStream bugs entirely).
            // Encrypted uploads still need the stream path for the encryption transform.
            const useSlicedUpload = isWebKit && !encrypted && !isMultiFile;
            let multipartResult: MultipartStreamResult;

            if (useSlicedUpload) {
                console.log('[Upload] Using Safari slice-based multipart upload');
                multipartResult = await uploadMultipartSliced(
                    files[0],
                    uploadInfo,
                    updateProgress,
                    canceller,
                    onError,
                    () => {
                        totalRetryCount++;
                        const part1Bytes = partProgress[1] ?? 0;
                        updateProgress(1, part1Bytes);
                    },
                    canResume ? uploadInfo.id : undefined,
                );
            } else {
                multipartResult = await uploadMultipartStream(
                    stream,
                    uploadInfo,
                    updateProgress,
                    canceller,
                    onError,
                    totalSize,
                    () => {
                        totalRetryCount++;
                        const part1Bytes = partProgress[1] ?? 0;
                        updateProgress(1, part1Bytes);
                    },
                    canResume ? uploadInfo.id : undefined,
                    encrypted,
                );
            }

            // Handle fallback: stream produced too little data for multipart
            if ('fallbackBlob' in multipartResult) {
                console.log(
                    `[Upload] Falling back to single-part upload (${(multipartResult.fallbackBlob.size / 1024).toFixed(1)}KB)`,
                );

                // Abort the multipart upload
                if (uploadInfo.uploadId) {
                    await abortMultipartUpload(
                        uploadInfo.id,
                        uploadInfo.uploadId,
                        uploadInfo.uploadToken,
                    );
                }

                // Request a new single-part upload URL
                const fallbackResponse = await fetch(`${API_BASE_URL}/upload/url`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fileSize: multipartResult.fallbackBlob.size,
                        encrypted,
                        timeLimit,
                        dlimit: downloadLimit,
                    }),
                });

                if (!fallbackResponse.ok) {
                    throw new Error(`HTTP ${fallbackResponse.status}`);
                }

                const fallbackInfo: UploadUrlResponse = await fallbackResponse.json();
                if (!fallbackInfo.useSignedUrl) {
                    throw new Error('Pre-signed URLs not available for fallback');
                }

                // The persisted resume state points at the multipart upload we
                // just aborted — remove it so the next visit doesn't offer a
                // resume that can only fail with "session expired"
                deleteUploadState(uploadInfo.id).catch(() => {
                    // Intentionally ignored — best-effort cleanup
                });

                // Use the new file ID and owner from the fallback response
                uploadInfo = fallbackInfo;

                uploadResult = await uploadSinglePartWithRetry(
                    multipartResult.fallbackBlob,
                    fallbackInfo.url,
                    (loaded) => updateProgress(1, loaded),
                    canceller,
                    () => {
                        totalRetryCount++;
                        updateProgress(1, partProgress[1] ?? 0);
                    },
                );
            } else {
                uploadResult = multipartResult;
            }
        } else {
            // Single part upload
            const blob = await new Response(stream).blob();
            uploadResult = await uploadSinglePartWithRetry(
                blob,
                uploadInfo.url,
                (loaded) => updateProgress(1, loaded),
                canceller,
                () => {
                    totalRetryCount++;
                    updateProgress(1, partProgress[1] ?? 0);
                },
            );
        }

        if (canceller.cancelled) {
            // Cleanup (abort + persisted state) happens in the finally block,
            // which also covers cancellations that surface as throws from the
            // part uploaders instead of reaching this check.
            throw new Error('Upload cancelled');
        }

        // Complete the upload
        const metadataString = encrypted
            ? arrayToB64(await keychain.encryptMetadata(metadata))
            : btoa(unescape(encodeURIComponent(JSON.stringify(metadata))));

        const completeResponse = await fetchWithRetry(`${API_BASE_URL}/upload/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: uploadInfo.id,
                metadata: metadataString,
                ...(encrypted && { authKey: await keychain.authKeyB64() }),
                actualSize: uploadResult.actualSize || totalSize,
                ...(uploadResult.parts && { parts: uploadResult.parts }),
            }),
        });

        if (!completeResponse.ok) {
            const errorText = await completeResponse.text();
            const err = new Error(`Failed to complete upload: ${errorText}`);
            captureError(err, {
                operation: 'upload.complete',
                extra: {
                    fileId: uploadInfo.id,
                    httpStatus: completeResponse.status,
                    encrypted,
                    multipart: uploadInfo.multipart,
                    totalSize,
                    responsePreview: errorText.substring(0, 200),
                },
            });
            throw err;
        }

        const completionLifetime = await readCompletionLifetime(completeResponse);
        uploadSucceeded = true;

        // Clean up persisted upload state
        if (uploadInfo.multipart) {
            deleteUploadState(uploadInfo.id).catch(() => {
                // Intentionally ignored — best-effort cleanup
            });
        }

        // Always use frontend origin for download URL (backend may return its own URL)
        // Don't include hash here - ShareDialog will append the secretKey
        const downloadUrl = `${window.location.origin}/download/${uploadInfo.id}`;

        return {
            id: uploadInfo.id,
            url: downloadUrl,
            ownerToken: uploadInfo.owner,
            duration: Date.now() - startTime,
            ...completionLifetime,
        };
    } finally {
        cleanupStatusPoll();
        // Cancelled or terminally failed: release the streaming zip's per-file
        // source streams. Neither client-zip's own cancel handler (a no-op for
        // plain-Array entries) nor the reader.releaseLock() in
        // uploadMultipartStream reaches them, so without this the readers of
        // every already-started file stay locked and every remaining source
        // stays open until GC.
        if (!uploadSucceeded) {
            await streamingZip?.dispose();
        }
        // If cancelled, abort the server-side multipart upload (S3 parts +
        // Redis metadata would otherwise linger until TTL) and clean up
        // persisted state — the user intentionally cancelled, so don't offer
        // resume on next visit. A cancel usually surfaces as a throw from the
        // part uploaders, so this must live here rather than on the happy path.
        if (canceller.cancelled && uploadInfo.multipart) {
            if (uploadInfo.uploadId) {
                await abortMultipartUpload(
                    uploadInfo.id,
                    uploadInfo.uploadId,
                    uploadInfo.uploadToken,
                );
            }
            deleteUploadState(uploadInfo.id).catch(() => {
                // Intentionally ignored — best-effort cleanup
            });
        } else if (!uploadSucceeded && uploadInfo.multipart && isMultiFile) {
            // Terminal failure of a non-resumable upload (multi-file zips are
            // never persisted for resume): nothing will ever pick these parts
            // up again, so abort the server-side multipart instead of leaving
            // S3 parts + Redis metadata + the provider file counter dangling.
            // Single-file uploads are left intact — their persisted state
            // powers the resume prompt on the next visit.
            if (uploadInfo.uploadId) {
                await abortMultipartUpload(
                    uploadInfo.id,
                    uploadInfo.uploadId,
                    uploadInfo.uploadToken,
                );
            }
        } else if (!uploadSucceeded && !uploadInfo.multipart) {
            // Single-part uploads have no uploadId to abort and are never
            // persisted for resume, so a terminal failure (or a cancel) would
            // otherwise strand the /upload/url metadata and the provider file
            // counter until TTL. Release the allocation explicitly.
            await releaseUploadAllocation(uploadInfo.id, uploadInfo.owner);
        }
    }
}

/**
 * Work a declined engine attempt hands back to the legacy pipeline so the
 * fallback does not redo it. Only the buffered zip is worth carrying: it is
 * the one expensive artefact the engine builds before it can know its own
 * size, and it is byte-identical to the one the legacy path would build.
 */
interface EngineDeclineHandoff {
    zip?: { blob: Blob; filename: string };
}

/**
 * Upload through the worker+OPFS engine (`lib/upload-engine/`). Allocation
 * mirrors the legacy path exactly; the resulting `EngineJob` +
 * `CompletionEnvelope` then cross into a dedicated worker that stages
 * record-aligned parts in OPFS, uploads them, and finishes `/upload/complete`
 * itself.
 *
 * Returns undefined to decline, and the caller falls through to the legacy
 * pipeline: either the real (post-zip) size is not multipart-sized and the
 * engine — which only runs multipart — never starts, or the backend declined
 * multipart for an allocation that was made anyway (which is then released).
 */
async function uploadFilesViaEngine(
    options: UploadOptions,
    keychain: Keychain,
    canceller: Canceller,
    handoff: EngineDeclineHandoff,
): Promise<UploadResult | undefined> {
    const {
        files,
        encrypted = true,
        timeLimit,
        downloadLimit,
        onProgress,
        onZipProgress,
        handles,
    } = options;
    const startTime = Date.now();
    const isMultiFile = files.length > 1;
    const totalInputSize = files.reduce((sum, f) => sum + f.size, 0);

    // Source selection mirrors the legacy strategy: buffered DEFLATE zip for
    // small multi-file batches (exact compressed size known before
    // allocation, ingested as a seekable blob), worker-side streaming zip for
    // large ones (STORE — size fully determined by entry names and sizes),
    // and the file itself for single files.
    let source: EngineSource;
    let plainSize: number;
    let zipFilename: string | undefined;
    if (isMultiFile) {
        const streamingThreshold = isWebKit ? 100 * 1024 * 1024 : STREAMING_ZIP_THRESHOLD;
        if (totalInputSize >= streamingThreshold) {
            const nextEntryName = createNameDeduplicator();
            const names = files.map((f) => nextEntryName(f.name));
            source = { kind: 'zip', files, names };
            // The same exact-size prediction createStreamingZip uses.
            plainSize = Number(
                predictLength(names.map((name, i) => ({ name, size: files[i].size }))),
            );
            zipFilename = generateZipFilename(
                files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
            );
        } else {
            const zipResult = await createZipFromUploadFiles(files, onZipProgress);
            source = { kind: 'blob', blob: zipResult.blob };
            plainSize = zipResult.blob.size;
            zipFilename = zipResult.filename;
            handoff.zip = { blob: zipResult.blob, filename: zipResult.filename };
            onZipProgress?.(100);
        }
    } else {
        source = { kind: 'file', file: files[0] };
        plainSize = files[0].size;
    }
    const totalSize = encrypted ? calculateEncryptedSize(plainSize) : plainSize;

    // The delegation gate upstream could only see the declared input size.
    // Now that the real one is known, apply the multipart gate the legacy
    // path applies — DEFLATE routinely takes a multi-file batch under it, and
    // the engine only runs multipart. Declining here, before allocating, is
    // what keeps a compressible batch from paying for a multipart the backend
    // would decline on exactly this threshold (`useMultipart` in
    // routes/upload.ts).
    if (totalSize <= UPLOAD_LIMITS.MULTIPART_THRESHOLD) {
        console.log('[Upload] Zipped size is not multipart-sized — using legacy pipeline');
        recordEngineFallback('below-threshold');
        return undefined;
    }

    // A cancel landing between zip construction and allocation must stop here
    // — nothing server-side exists yet.
    if (canceller.cancelled) {
        throw new Error('Upload cancelled');
    }

    // Allocation — the same /upload/url request the legacy path makes.
    const uploadResponse = await fetch(`${API_BASE_URL}/upload/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fileSize: totalSize,
            encrypted,
            timeLimit,
            dlimit: downloadLimit,
        }),
    });
    if (!uploadResponse.ok) {
        throw new Error(`HTTP ${uploadResponse.status}`);
    }
    const uploadInfo: UploadUrlResponse = await uploadResponse.json();
    if (!uploadInfo.useSignedUrl) {
        throw new Error('Pre-signed URLs not available');
    }
    if (!uploadInfo.multipart || !uploadInfo.parts || !uploadInfo.uploadId) {
        // The backend sized this allocation below its multipart threshold and
        // the engine only runs multipart. Release the allocation and fall
        // through to the legacy pipeline (which allocates afresh) — and
        // re-label the telemetry attempt, or the success event would credit
        // the worker engine for a legacy-performed upload [R16].
        console.log('[Upload] Backend declined multipart — using legacy pipeline');
        recordEngineFallback('backend-declined-multipart');
        await releaseUploadAllocation(uploadInfo.id, uploadInfo.owner);
        return undefined;
    }
    if (canceller.cancelled) {
        // The server-side multipart + metadata now exist — abort them.
        await abortMultipartUpload(uploadInfo.id, uploadInfo.uploadId);
        throw new Error('Upload cancelled');
    }

    console.log('[Upload] Using worker upload engine');

    // Metadata and auth exactly as the legacy completion computes them.
    const metadata: {
        files: { name: string; size: number; type: string }[];
        zipped?: boolean;
        zipFilename?: string;
        eceVersion?: number;
    } = {
        files: files.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type || 'application/octet-stream',
        })),
        ...(encrypted && { eceVersion: ECE_VERSION }),
    };
    if (isMultiFile && zipFilename) {
        metadata.zipped = true;
        metadata.zipFilename = zipFilename;
    }
    const metadataString = encrypted
        ? arrayToB64(await keychain.encryptMetadata(metadata))
        : btoa(unescape(encodeURIComponent(JSON.stringify(metadata))));

    const envelope: CompletionEnvelope = {
        fileId: uploadInfo.id,
        metadata: metadataString,
        authKeyB64: await keychain.authKeyB64(),
        manifest: files.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type || 'application/octet-stream',
        })),
        zipFilename,
        expectedSize: totalSize,
        encrypted,
        secretKeyB64: encrypted ? keychain.secretKeyB64 : undefined,
        timeLimit: timeLimit || 86400,
        downloadLimit: downloadLimit || 1,
    };
    const job: EngineJob = {
        fileId: uploadInfo.id,
        uploadId: uploadInfo.uploadId,
        uploadToken: uploadInfo.uploadToken,
        ownerToken: uploadInfo.owner,
        partUrls: uploadInfo.parts.map((p) => p.url),
        partSize: getEffectivePartSize(uploadInfo.partSize || 0, encrypted),
        encrypted,
        secretKeyB64: encrypted ? keychain.secretKeyB64 : undefined,
        declaredTotalSize: totalSize,
        source,
    };

    // Persisted-handle one-click resume [R13]: stash the single file's handle
    // plus verification facts in the engine lease *before* the worker writes
    // its own lease (the engine's lease write preserves these fields). Best
    // effort — a Chromium-only progressive enhancement must never fail the
    // upload. Multi-file resumes are start-fresh only, so only single-file
    // uploads persist a handle.
    const sourceHandle = isMultiFile ? undefined : handles?.[0];
    if (sourceHandle) {
        try {
            const engineState = await openEngineState();
            await engineState.putLease({
                fileId: uploadInfo.id,
                uploadId: uploadInfo.uploadId,
                uploadToken: uploadInfo.uploadToken,
                ownerToken: uploadInfo.owner,
                createdAt: Date.now(),
                engineVersion: 1,
                handles: [sourceHandle],
                handleFacts: [
                    {
                        name: files[0].name,
                        size: files[0].size,
                        lastModified: files[0].lastModified,
                        fingerprint: await computeContentFingerprint(files[0]),
                    },
                ],
            });
        } catch (error) {
            console.warn('[Upload] Could not persist file handle for one-click resume:', error);
        }
    }

    const progress = createEngineProgressReporter(totalSize, onProgress);
    try {
        await runEngineInWorker(
            job,
            envelope,
            { onProgress: progress.onProgress, onRetry: progress.onRetry },
            canceller,
        );
    } finally {
        progress.stop();
    }

    return {
        id: uploadInfo.id,
        url: `${window.location.origin}/download/${uploadInfo.id}`,
        ownerToken: uploadInfo.owner,
        duration: Date.now() - startTime,
    };
}

/**
 * Resume an interrupted multipart upload using persisted state from IndexedDB
 */
export async function resumeUpload(
    file: File,
    state: PersistedUpload,
    onProgress?: (progress: UploadProgress) => void,
    onError?: (error: UploadError) => void,
    canceller?: Canceller,
): Promise<UploadResult> {
    // Engine-lease routing: each pipeline resumes only its own uploads. A
    // fileId with an engine lease belongs to the worker engine — the engine
    // never writes the legacy bolter-uploads database, and vice versa.
    if (await hasEngineLease(state.fileId)) {
        return resumeEngineUpload(state.fileId, onProgress, canceller);
    }

    const startTime = Date.now();
    const cancel = canceller || new Canceller();

    // Reconstruct keychain if encrypted
    let keychain: Keychain | null = null;
    if (state.encrypted && state.secretKeyB64) {
        keychain = new Keychain(state.secretKeyB64);
    }

    // Find contiguous prefix of completed parts (concurrent uploads may leave gaps)
    // Only the contiguous prefix can be safely skipped — parts after a gap need re-uploading
    const sortedCompleted = [...state.completedParts].sort((a, b) => a.PartNumber - b.PartNumber);
    let contiguousCount = 0;
    for (const p of sortedCompleted) {
        if (p.PartNumber === contiguousCount + 1) {
            contiguousCount++;
        } else {
            break;
        }
    }
    const trulyCompletedParts = sortedCompleted.slice(0, contiguousCount);

    // Use plaintext part size for file offset (encrypted part size includes ECE
    // overhead). Derive from the effective (record-aligned) part size so the skip
    // math is exactly consistent with how the parts were originally cut.
    const recordsPerPart = state.encrypted
        ? getEffectivePartSize(state.partSize, true) / ECE_ENCRYPTED_RECORD_SIZE
        : 0;
    const plaintextPartSize = state.encrypted
        ? recordsPerPart * ECE_RECORD_SIZE
        : state.plaintextPartSize || state.partSize;
    const skipBytes = contiguousCount * plaintextPartSize;

    // Verify the selected file really is the one whose prefix was uploaded.
    // (name, size, mtime) is not an identity: a different file with the same
    // tuple would be spliced tail-onto-prefix, and because the key and ECE
    // record counter are reused the hybrid decrypts cleanly into a corrupt file.
    if (contiguousCount > 0) {
        if (!state.contentFingerprint) {
            throw new Error(
                'This interrupted upload was saved by an older version and cannot be safely resumed. Please start a new upload.',
            );
        }
        const fingerprint = await computeContentFingerprint(file);
        if (fingerprint !== state.contentFingerprint) {
            throw new Error(
                'The selected file does not match the interrupted upload. Please choose the original file or start a new upload.',
            );
        }
    }

    // Request new pre-signed URLs for remaining parts
    const resumeResponse = await fetch(`${API_BASE_URL}/upload/multipart/${state.fileId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            uploadId: state.uploadId,
            completedPartNumbers: trulyCompletedParts.map((p) => p.PartNumber),
            // Authorizes the re-signing of part URLs (audit #52). Absent for
            // records persisted before v4, which the backend still accepts.
            ...(state.uploadToken ? { uploadToken: state.uploadToken } : {}),
        }),
    });

    if (!resumeResponse.ok) {
        // Only 400/404/410 mean the session is genuinely dead (the backend
        // returns 404 for missing metadata and 400 for an uploadId mismatch).
        // A 5xx/429 — or an edge 502/503 during a deploy — is transient, and
        // discarding state there destroys the completed-part list, the uploadId
        // and, for encrypted uploads, the only copy of the secret key.
        const status = resumeResponse.status;
        if (status === 400 || status === 404 || status === 410) {
            await deleteUploadState(state.fileId);
            throw new Error('Upload session expired. Please start a new upload.');
        }
        throw new Error(
            `Resume temporarily unavailable (HTTP ${status}) — your progress is saved, please try again.`,
        );
    }

    const resumeInfo: {
        parts: Array<{ partNumber: number; url: string; minSize: number; maxSize: number }>;
        partSize: number;
        numParts: number;
    } = await resumeResponse.json();

    // Create a stream from the file, skipping already-uploaded data
    const remainingBlob = file.slice(skipBytes);
    let stream: ReadableStream<Uint8Array> = remainingBlob.stream();

    // If encrypted, wrap with encryption stream starting at the correct counter.
    // Each completed part held exactly recordsPerPart whole ECE records.
    if (state.encrypted && keychain) {
        const initialCounter = contiguousCount * recordsPerPart;
        stream = stream.pipeThrough(createEncryptionStream(keychain, initialCounter));
    }

    // Track progress
    let smoothedSpeed = 0;
    let smoothedRemaining = 0;
    let lastProgressTime = startTime;
    let lastProgressBytes = 0;
    let lastDisplayTime = startTime;
    let totalRetryCount = 0;
    let lastPartProgressTime = Date.now();
    const partProgress: Record<number, number> = {};

    // Account for already-completed data in progress.
    // Parts were cut at the *effective* (record-aligned) part size, so that —
    // not the raw allocated partSize — is how many bytes each completed part
    // actually holds at S3.
    const uploadedPartSize = getEffectivePartSize(state.partSize, state.encrypted);
    const alreadyUploaded = contiguousCount * uploadedPartSize;
    const remainingPlaintext = Math.max(0, file.size - skipBytes);
    const totalSize =
        alreadyUploaded +
        (state.encrypted ? calculateEncryptedSize(remainingPlaintext) : remainingPlaintext);

    const updateProgress = (partNum: number, loaded: number) => {
        partProgress[partNum] = loaded;
        const partLoaded = Object.values(partProgress).reduce((sum, p) => sum + p, 0);
        const totalLoaded = alreadyUploaded + partLoaded;

        const now = Date.now();

        // When partLoaded drops (part retry reset), re-baseline so
        // the next progress event doesn't produce a huge speed spike.
        if (partLoaded < lastProgressBytes) {
            lastProgressBytes = partLoaded;
            lastProgressTime = now;
        }

        const elapsed = (now - lastProgressTime) / 1000;
        // Use partLoaded (not totalLoaded) for speed calculation to avoid
        // the alreadyUploaded offset skewing the delta between updates
        const bytesInPeriod = partLoaded - lastProgressBytes;
        const instantSpeed = elapsed > 0 ? Math.max(0, bytesInPeriod / elapsed) : 0;

        if (bytesInPeriod > 0) {
            lastPartProgressTime = now;
        }

        const displayElapsed = (now - lastDisplayTime) / 1000;
        if (displayElapsed >= 1 || lastDisplayTime === startTime) {
            smoothedSpeed =
                smoothedSpeed === 0 ? instantSpeed : smoothedSpeed * 0.7 + instantSpeed * 0.3;
            smoothedRemaining = smoothedSpeed > 0 ? (totalSize - totalLoaded) / smoothedSpeed : 0;
            lastDisplayTime = now;
            lastProgressTime = now;
            lastProgressBytes = partLoaded;
        }

        const isOffline = !navigator.onLine;
        let connectionQuality: UploadProgress['connectionQuality'];
        if (isOffline) {
            connectionQuality = 'offline';
        } else if (smoothedSpeed === 0 || now - lastPartProgressTime > 10000) {
            connectionQuality = 'stalled';
        } else if (smoothedSpeed < 1 * 1024 * 1024) {
            connectionQuality = 'slow';
        } else if (smoothedSpeed < 10 * 1024 * 1024) {
            connectionQuality = 'fair';
        } else {
            connectionQuality = 'good';
        }

        onProgress?.({
            loaded: Math.min(totalLoaded, totalSize),
            total: totalSize,
            percentage: Math.min((totalLoaded / totalSize) * 100, 100),
            speed: smoothedSpeed,
            remainingTime: smoothedRemaining,
            retryCount: totalRetryCount,
            isOffline,
            connectionQuality,
        });
    };

    // Upload remaining parts using existing multipart machinery
    const uploadInfoForResume: UploadUrlResponse = {
        useSignedUrl: true,
        multipart: true,
        id: state.fileId,
        owner: state.ownerToken,
        uploadId: state.uploadId,
        parts: resumeInfo.parts,
        partSize: resumeInfo.partSize,
        url: '',
    };

    // When the interruption happened between the last part upload and
    // /upload/complete, every part already exists at S3 — there is nothing to
    // stream, so skip straight to completion. (uploadMultipartStream cannot
    // handle an empty part list: its read loop would never drain the stream.)
    let newlyUploadedParts: { PartNumber: number; ETag: string }[] = [];
    let newlyUploadedBytes = 0;
    if (resumeInfo.parts.length > 0) {
        const multipartResult = await uploadMultipartStream(
            stream,
            uploadInfoForResume,
            updateProgress,
            cancel,
            onError,
            totalSize,
            () => {
                totalRetryCount++;
            },
            state.fileId,
            state.encrypted,
            true, // isResume: prior parts exist, never fall back to single-part
        );

        if ('fallbackBlob' in multipartResult) {
            throw new Error('Resume failed: unexpected fallback');
        }
        newlyUploadedParts = multipartResult.parts || [];
        newlyUploadedBytes = multipartResult.actualSize;
    }

    // True object size. The old `totalParts * partSize` was allocated capacity,
    // which overstates the size of essentially every resumed upload (the final
    // part is nearly always partial) and makes every download report a spurious
    // size mismatch.
    //
    // `alreadyUploaded` is derived from the part grid, so it is only exact while
    // the contiguous prefix consists of full (non-trailing) parts. Once the
    // prefix reaches the end of the file — the "interrupted between the last
    // part and /upload/complete" resume, where nothing is left to stream — the
    // grid counts the partial trailing part as a whole one (21MB in 3x10MB
    // parts would report 30MB). In that case the object is exactly the whole
    // payload, so derive the size from the file itself.
    const wholePayloadSize = state.encrypted ? calculateEncryptedSize(file.size) : file.size;
    const prefixCoversWholeFile = skipBytes >= file.size;
    const actualUploadedSize = prefixCoversWholeFile
        ? wholePayloadSize
        : alreadyUploaded + newlyUploadedBytes;

    if (cancel.cancelled) {
        throw new Error('Upload cancelled');
    }

    // Combine completed parts (contiguous prefix + newly uploaded)
    // Deduplicate by PartNumber, preferring newly uploaded ETags over persisted ones
    const partMap = new Map<number, { PartNumber: number; ETag: string }>();
    for (const p of trulyCompletedParts) {
        partMap.set(p.PartNumber, p);
    }
    for (const p of newlyUploadedParts) {
        partMap.set(p.PartNumber, p);
    }
    const allParts = [...partMap.values()].sort((a, b) => a.PartNumber - b.PartNumber);

    // Complete the upload
    let metadataString: string;
    if (state.encrypted && keychain) {
        const metadata = {
            files: [
                { name: file.name, size: file.size, type: file.type || 'application/octet-stream' },
            ],
            // ECE format marker — see the upload path in uploadFiles().
            eceVersion: ECE_VERSION,
        };
        metadataString = arrayToB64(await keychain.encryptMetadata(metadata));
    } else {
        const metadata = {
            files: [
                { name: file.name, size: file.size, type: file.type || 'application/octet-stream' },
            ],
        };
        metadataString = btoa(unescape(encodeURIComponent(JSON.stringify(metadata))));
    }

    const completeResponse = await fetchWithRetry(`${API_BASE_URL}/upload/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: state.fileId,
            metadata: metadataString,
            ...(state.encrypted && keychain && { authKey: await keychain.authKeyB64() }),
            actualSize: actualUploadedSize,
            parts: allParts,
        }),
    });

    if (!completeResponse.ok) {
        throw new Error(`Failed to complete resumed upload: ${await completeResponse.text()}`);
    }

    const completionLifetime = await readCompletionLifetime(completeResponse);

    // Clean up persisted state
    await deleteUploadState(state.fileId);

    const downloadUrl = `${window.location.origin}/download/${state.fileId}`;

    return {
        id: state.fileId,
        url: downloadUrl,
        ownerToken: state.ownerToken,
        duration: Date.now() - startTime,
        // Resumed uploads are exactly the case #15 describes: the TTL started
        // days ago at /upload/url, so the server's number is the only correct
        // one here.
        ...completionLifetime,
    };
}

/**
 * Resume a persisted worker-engine upload from its lease — the source-free
 * paths ("Finish upload — no file selection needed"): the worker either
 * replays `/upload/complete` from durable ETags or uploads the staged
 * remainder, then completes. Rejects with `ResumeNeedsSourceError` (relayed
 * as a worker error) when production was still incomplete.
 */
export async function resumeEngineUpload(
    fileId: string,
    onProgress?: (progress: UploadProgress) => void,
    canceller?: Canceller,
): Promise<UploadResult> {
    const startTime = Date.now();
    const lease = await getEngineLease(fileId);
    if (!lease) {
        throw new Error('This upload is no longer resumable. Please start a new upload.');
    }
    const cancel = canceller ?? new Canceller();
    // Total is unknown until the worker's first progress event carries it.
    const progress = createEngineProgressReporter(0, onProgress);
    try {
        await resumeEngineUploadInWorker(
            fileId,
            { onProgress: progress.onProgress, onRetry: progress.onRetry },
            cancel,
        );
    } finally {
        progress.stop();
    }
    return {
        id: fileId,
        url: `${window.location.origin}/download/${fileId}`,
        ownerToken: lease.ownerToken,
        duration: Date.now() - startTime,
    };
}

/**
 * One-click engine resume from a persisted File System Access handle [R13]:
 * the caller has already re-acquired and *verified* the source file
 * (`verifyHandleFile` against the lease's `handleFacts`), so this rebuilds
 * the engine job around it — fresh part URLs from
 * `/upload/multipart/:id/resume` (the originals died with the crashed run and
 * are likely expired), the persisted producer checkpoint decides where
 * production restarts — and re-enters the worker engine.
 */
export async function resumeEngineUploadWithFile(
    fileId: string,
    file: File,
    onProgress?: (progress: UploadProgress) => void,
    canceller?: Canceller,
): Promise<UploadResult> {
    const startTime = Date.now();
    const state = await openEngineState();
    const [lease, envelope, parts] = await Promise.all([
        state.getLease(fileId),
        state.getEnvelope(fileId),
        state.getParts(fileId),
    ]);
    if (!lease || !envelope) {
        throw new Error('This upload is no longer resumable. Please start a new upload.');
    }

    const completedPartNumbers = parts.filter((p) => p.uploaded).map((p) => p.partNumber);
    const resumeResponse = await fetch(`${API_BASE_URL}/upload/multipart/${fileId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            uploadId: lease.uploadId,
            completedPartNumbers,
            ...(lease.uploadToken !== undefined && { uploadToken: lease.uploadToken }),
        }),
    });
    if (!resumeResponse.ok) {
        const status = resumeResponse.status;
        // Engine state is deliberately left intact on the dead-session
        // statuses too — the resume card's "Start fresh" owns the discard.
        if (status === 400 || status === 404 || status === 410) {
            throw new Error('Upload session expired. Please start a new upload.');
        }
        throw new Error(
            `Resume temporarily unavailable (HTTP ${status}) — your progress is saved, please try again.`,
        );
    }
    const resumeInfo: {
        parts: Array<{ partNumber: number; url: string }>;
        partSize: number;
        numParts: number;
    } = await resumeResponse.json();

    // Full index-0-=-part-1 array; already-uploaded parts keep an empty slot
    // the uploader never reads (same shape the worker's URL refresh builds).
    const maxPart = Math.max(
        resumeInfo.numParts ?? 0,
        ...resumeInfo.parts.map((p) => p.partNumber),
        0,
    );
    const partUrls = new Array<string>(maxPart).fill('');
    for (const part of resumeInfo.parts) {
        partUrls[part.partNumber - 1] = part.url;
    }

    const job: EngineJob = {
        fileId,
        uploadId: lease.uploadId,
        uploadToken: lease.uploadToken,
        ownerToken: lease.ownerToken,
        partUrls,
        partSize: getEffectivePartSize(resumeInfo.partSize || 0, envelope.encrypted),
        encrypted: envelope.encrypted,
        secretKeyB64: envelope.secretKeyB64,
        declaredTotalSize: envelope.expectedSize,
        source: { kind: 'file', file },
    };

    const cancel = canceller ?? new Canceller();
    const progress = createEngineProgressReporter(envelope.expectedSize, onProgress);
    try {
        await runEngineInWorker(
            job,
            envelope,
            { onProgress: progress.onProgress, onRetry: progress.onRetry },
            cancel,
        );
    } finally {
        progress.stop();
    }
    return {
        id: fileId,
        url: `${window.location.origin}/download/${fileId}`,
        ownerToken: lease.ownerToken,
        duration: Date.now() - startTime,
    };
}

/**
 * Create a readable stream from files
 */
function createFileStream(
    files: File[],
    keychain: Keychain,
    encrypt: boolean,
): ReadableStream<Uint8Array> {
    const fileIterator = files[Symbol.iterator]();
    let currentFile: File | null = null;
    let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const baseStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            while (true) {
                if (!currentReader) {
                    const result = fileIterator.next();
                    if (result.done) {
                        controller.close();
                        return;
                    }
                    currentFile = result.value;
                    try {
                        currentReader = currentFile.stream().getReader();
                    } catch (e) {
                        throw new FileReadError(currentFile.name, e);
                    }
                }

                try {
                    const { done, value } = await currentReader.read();
                    if (done) {
                        currentReader = null;
                        continue;
                    }

                    controller.enqueue(value);
                    return;
                } catch (e) {
                    throw new FileReadError(currentFile?.name ?? 'unknown', e);
                }
            }
        },
    });

    if (!encrypt) {
        return baseStream;
    }

    return baseStream.pipeThrough(createEncryptionStream(keychain));
}

/**
 * Create a readable stream from a blob (for zipped multi-file uploads)
 */
function createBlobStream(
    blob: Blob,
    keychain: Keychain,
    encrypt: boolean,
): ReadableStream<Uint8Array> {
    const baseStream = blob.stream();

    if (!encrypt) {
        return baseStream;
    }

    return baseStream.pipeThrough(createEncryptionStream(keychain));
}

/**
 * Upload the whole payload with one PUT.
 *
 * Mirrors uploadPart's resilience: progress-based stall detection (paused while
 * offline) rather than a hard timeout, and a cancelled check before the request
 * is opened. Retry/backoff lives in uploadSinglePartWithRetry.
 */
function uploadSinglePart(
    blob: Blob,
    url: string,
    onProgress: (loaded: number) => void,
    canceller: Canceller,
): Promise<{ actualSize: number }> {
    if (canceller.cancelled) {
        return Promise.reject(new Error('Upload cancelled'));
    }
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        canceller.addXhr(xhr);

        let stallTimer: ReturnType<typeof setTimeout>;
        let stalledAbort = false;
        let settled = false;

        const cleanup = () => {
            clearTimeout(stallTimer);
            window.removeEventListener('offline', handleOffline);
            window.removeEventListener('online', handleOnline);
            canceller.removeXhr(xhr);
        };

        const fail = (err: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(err);
        };

        const resetStallTimer = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                stalledAbort = true;
                cleanup();
                xhr.abort();
                fail(new Error('Upload stalled'));
            }, STALL_TIMEOUT);
        };

        // Pause stall detection while offline — the retry layer waits for
        // connectivity instead of burning the retry budget on a dead link
        const handleOffline = () => {
            clearTimeout(stallTimer);
        };
        const handleOnline = () => {
            resetStallTimer();
        };
        window.addEventListener('offline', handleOffline);
        window.addEventListener('online', handleOnline);

        xhr.upload.addEventListener('progress', (e) => {
            resetStallTimer();
            if (e.lengthComputable) {
                onProgress(e.loaded);
            }
        });

        xhr.addEventListener('loadstart', resetStallTimer);

        xhr.addEventListener('loadend', () => {
            cleanup();
            if (settled) {
                return;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                settled = true;
                resolve({ actualSize: blob.size });
            } else if (!stalledAbort) {
                let errorDetails = `HTTP ${xhr.status}`;
                if (xhr.statusText) {
                    errorDetails += ` (${xhr.statusText})`;
                }
                const err = new Error(errorDetails);
                captureError(err, {
                    operation: 'upload.single',
                    extra: {
                        httpStatus: xhr.status,
                        statusText: xhr.statusText,
                        blobSize: blob.size,
                        responsePreview: xhr.responseText?.substring(0, 200),
                    },
                    level: 'warning',
                });
                fail(err);
            }
        });

        xhr.addEventListener('error', () => {
            cleanup();
            const err = new Error('Network error');
            captureError(err, {
                operation: 'upload.single.network',
                extra: { blobSize: blob.size },
                level: 'warning',
            });
            fail(err);
        });

        xhr.open('PUT', url);
        xhr.send(blob);
    });
}

/**
 * Single-part upload with the same retry budget, backoff and offline pausing as
 * the multipart path. Without this a single dropped packet on a 90MB upload
 * discards the whole transfer with no retry and no resume record.
 *
 * No signed-URL refresh, deliberately. The PUT URL is signed for
 * URL_EXPIRATION_SECONDS (7 days, upload.ts) while the worst-case retry window
 * here is MAX_RETRIES + 1 attempts x STALL_TIMEOUT plus the capped backoff
 * ladder — about 17 minutes — so the URL cannot expire mid-run. The only way to
 * outlive it is an offline pause measured in days, which equally breaks the
 * multipart path (part URLs are re-signed only by /upload/multipart/:id/resume
 * on the next visit, never mid-run). Revisit if URL_EXPIRATION_SECONDS is cut to
 * anything near the retry window.
 */
async function uploadSinglePartWithRetry(
    blob: Blob,
    url: string,
    onProgress: (loaded: number) => void,
    canceller: Canceller,
    onRetry?: () => void,
): Promise<{ actualSize: number }> {
    for (let attempt = 0; ; attempt++) {
        if (canceller.cancelled) {
            throw new Error('Upload cancelled');
        }
        try {
            return await uploadSinglePart(blob, url, onProgress, canceller);
        } catch (error: unknown) {
            if (canceller.cancelled) {
                // A mid-flight cancel aborts the XHR, which surfaces from
                // uploadSinglePart as a raw `HTTP 0` (abort dispatches loadend
                // with status 0). Normalise it the way the multipart read loop
                // does — uploadFiles' own cancelled check sits after this await
                // and never runs, so without this the caller shows
                // "Upload failed: HTTP 0" instead of the cancel toast.
                throw new Error('Upload cancelled');
            }
            const err = error instanceof Error ? error : new Error(String(error));
            const isRetryable = isRetryableError(err);
            console.warn(
                `[Upload] Single-part upload failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}`,
                { retryable: isRetryable, blobSize: blob.size },
            );

            if (attempt >= MAX_RETRIES || !isRetryable) {
                captureError(err, {
                    operation: 'upload.single.exhausted',
                    extra: {
                        blobSize: blob.size,
                        retriesAttempted: attempt,
                        maxRetries: MAX_RETRIES,
                        isRetryable,
                        errorMessage: err.message,
                    },
                });
                throw err;
            }

            await waitForOnline(canceller);
            if (canceller.cancelled) {
                throw new Error('Upload cancelled');
            }

            const delay = retryDelayMs(attempt);
            console.log(`[Upload] Retrying single-part upload in ${(delay / 1000).toFixed(1)}s...`);
            onRetry?.();
            await cancellableDelay(delay, canceller);

            if (canceller.cancelled) {
                throw new Error('Upload cancelled');
            }
            onProgress(0); // Reset progress
        }
    }
}

/** Result from multipart upload - either completed parts or a fallback blob for single-part retry */
type MultipartStreamResult =
    | { parts: { PartNumber: number; ETag: string }[]; actualSize: number }
    | { fallbackBlob: Blob };

/**
 * Upload multipart using streaming with memory-efficient concurrency control
 * Uses a semaphore pattern to limit concurrent uploads and prevent memory exhaustion
 *
 * Returns { fallbackBlob } if the stream produces too little data for multipart upload,
 * signaling the caller to abort multipart and retry as a single-part PutObject upload.
 */
async function uploadMultipartStream(
    stream: ReadableStream<Uint8Array>,
    uploadInfo: UploadUrlResponse,
    onProgress: (partNum: number, loaded: number) => void,
    canceller: Canceller,
    onError?: (error: UploadError) => void,
    totalFileSize?: number,
    onRetry?: () => void,
    fileId?: string,
    encrypted = false,
    isResume = false,
): Promise<MultipartStreamResult> {
    const { parts, partSize } = uploadInfo;
    if (!parts || !partSize) {
        throw new Error('Invalid upload info');
    }

    // Cut encrypted parts on ECE record boundaries so resume can skip whole
    // records; the last allocated part absorbs the residual bytes.
    const effectivePartSize = getEffectivePartSize(partSize, encrypted);

    const MIN_PART = UPLOAD_LIMITS.MIN_PART_SIZE;
    // Safety cap: S3 max single-part size (5GB) — prevents unbounded memory if stream far exceeds estimate
    const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;

    // Adaptive concurrency based on file size
    const maxConcurrent = getConcurrentUploads(totalFileSize || 0);
    console.log(
        `[Upload] Starting multipart upload: ${parts.length} parts, ${partSize / (1024 * 1024)}MB each, concurrency: ${maxConcurrent}`,
    );

    const reader = stream.getReader();
    const completedParts: { PartNumber: number; ETag: string }[] = [];
    const partErrors: Record<number, { error: string; size: number }> = {};
    const failedPartNumbers: number[] = [];

    // Concurrency control state
    let activeUploads = 0;
    let totalUploadedSize = 0;
    let totalPartsQueued = 0;
    let totalPartsFinished = 0;

    // Track actual uploaded part sizes for pre-completion consistency check
    const uploadedPartSizes: Record<number, number> = {};

    // Promise to signal when all uploads are done
    let resolveAllDone!: () => void;
    const allDonePromise = new Promise<void>((resolve) => {
        resolveAllDone = resolve;
    });

    // Guard: prevent resolveAllDone() from firing before the final buffered
    // part has been flushed.  Without this, the one-shot Promise resolves
    // when totalPartsFinished === totalPartsQueued *before* the flush code
    // increments totalPartsQueued for the trailing part — causing the
    // completion call to fire with missing parts (race condition on iOS
    // Safari where few-part uploads finish before the stream is drained).
    let flushComplete = false;

    // First permanent part failure (retries exhausted or non-retryable). The
    // upload can never complete once this is set, so the read loop must stop
    // instead of streaming, encrypting and uploading every remaining part.
    let fatalPartError: Error | null = null;

    const markPartFinished = (): void => {
        totalPartsFinished++;
        console.log(
            `[Upload] Progress: ${totalPartsFinished}/${totalPartsQueued} parts finished, ${activeUploads} active`,
        );
        // Check if all done — only after the flush has finished
        // processing the final buffered part (flushComplete guard).
        if (flushComplete && totalPartsFinished >= totalPartsQueued) {
            resolveAllDone();
        }
    };

    // Drop every not-yet-started part, still counting it as finished so the
    // completion promise resolves and the caller actually settles.
    const drainPendingQueue = (): void => {
        while (pendingQueue.length > 0) {
            pendingQueue.shift();
            markPartFinished();
        }
    };

    // Upload a single part and manage concurrency
    const doUploadPart = async (
        partBlob: Blob,
        partNum: number,
        partUrl: string,
    ): Promise<void> => {
        try {
            if (canceller.cancelled) {
                throw new Error('Upload cancelled');
            }
            console.log(
                `[Upload] Part ${partNum} starting (${(partBlob.size / (1024 * 1024)).toFixed(1)}MB)`,
            );
            const result = await uploadPartWithRetry(
                partBlob,
                partUrl,
                partNum,
                (loaded) => onProgress(partNum, loaded),
                canceller,
                0,
                onRetry,
            );
            completedParts.push(result);
            uploadedPartSizes[partNum] = result.bytesSent;
            if (fileId) {
                updateCompletedPart(fileId, result).catch((e) =>
                    console.warn('[Upload] Failed to persist completed part:', e),
                );
            }
            console.log(`[Upload] Part ${partNum} complete`);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[Upload] Part ${partNum} failed:`, message);
            captureError(error, {
                operation: 'upload.part',
                extra: {
                    partNumber: partNum,
                    partSize: partBlob.size,
                    totalParts: parts.length,
                    uploadId: uploadInfo.uploadId,
                    totalFileSize: totalFileSize,
                    completedSoFar: completedParts.length,
                    failedSoFar: failedPartNumbers.length,
                    activeUploads,
                },
                level: 'warning',
            });
            partErrors[partNum] = {
                error: message,
                size: partBlob.size,
            };
            failedPartNumbers.push(partNum);
            if (!canceller.cancelled && !fatalPartError) {
                fatalPartError = error instanceof Error ? error : new Error(message);
            }
        } finally {
            activeUploads--;
            markPartFinished();

            // Start next queued upload if any
            processQueue();
        }
    };

    // Queue of pending uploads (not yet started due to concurrency limit)
    const pendingQueue: Array<{ blob: Blob; partNum: number; url: string }> = [];

    // Process the queue, starting uploads up to maxConcurrent
    const processQueue = (): void => {
        if (canceller.cancelled || fatalPartError) {
            drainPendingQueue();
            return;
        }
        while (pendingQueue.length > 0 && activeUploads < maxConcurrent) {
            const item = pendingQueue.shift();
            if (!item) {
                break;
            }
            activeUploads++;
            // Fire and forget - completion is tracked via totalPartsFinished
            doUploadPart(item.blob, item.partNum, item.url);
        }
    };

    // One-part delay buffer: hold the most recent completed part blob
    // so we can merge a small final part into it
    let bufferedItem: { blob: Blob; partNum: number; url: string } | null = null;

    const queueOrBuffer = (blob: Blob, partNum: number, url: string) => {
        if (bufferedItem) {
            // Queue the previously buffered part — it's not the last (non-trailing)
            // Skip 0-byte parts entirely — WebKit/Safari can produce these from empty stream chunks
            if (bufferedItem.blob.size === 0) {
                console.warn(
                    `[Upload] Skipping 0-byte non-trailing part ${bufferedItem.partNum} (WebKit empty chunk)`,
                );
                captureError(
                    new Error(`Skipped 0-byte non-trailing part ${bufferedItem.partNum}`),
                    {
                        operation: 'upload.part-size-validation',
                        extra: {
                            partNumber: bufferedItem.partNum,
                            uploadId: uploadInfo.uploadId,
                            totalParts: parts.length,
                            totalFileSize,
                        },
                        level: 'warning',
                    },
                );
                // Don't queue — just replace with the new part
                bufferedItem = { blob, partNum, url };
                return;
            }
            // Validate: all non-trailing parts must be exactly effectivePartSize for R2 compliance
            if (bufferedItem.blob.size !== effectivePartSize) {
                const diagnostic = {
                    partNumber: bufferedItem.partNum,
                    actualSize: bufferedItem.blob.size,
                    expectedSize: effectivePartSize,
                    uploadId: uploadInfo.uploadId,
                    totalParts: parts.length,
                    totalFileSize,
                };
                console.error(
                    `[Upload] Non-trailing part ${bufferedItem.partNum} size mismatch: ${bufferedItem.blob.size} !== ${effectivePartSize}`,
                    diagnostic,
                );
                captureError(
                    new Error(
                        `Non-trailing part size mismatch: part ${bufferedItem.partNum} is ${bufferedItem.blob.size} bytes, expected ${effectivePartSize}`,
                    ),
                    {
                        operation: 'upload.part-size-validation',
                        extra: diagnostic,
                    },
                );
            }
            totalUploadedSize += bufferedItem.blob.size;
            totalPartsQueued++;
            pendingQueue.push(bufferedItem);
            processQueue();
        }
        // Buffer the current part (might be the last)
        bufferedItem = { blob, partNum, url };
    };

    // Build the aggregated part-failure error the caller surfaces.
    const buildPartFailureError = (): Error => {
        const error: UploadError = {
            message: `Failed to upload ${failedPartNumbers.length} parts: ${[...failedPartNumbers].sort((a, b) => a - b).join(', ')}`,
            failedParts: [...failedPartNumbers].sort((a, b) => a - b),
            partErrors,
            retryable: true,
        };
        onError?.(error);
        return new Error(error.message);
    };

    // Short-circuit: once a part has permanently failed the upload is doomed,
    // so stop reading/encrypting/uploading the rest of the payload and report
    // the failure now instead of after every remaining byte has transferred.
    const throwIfPartFailedPermanently = (): void => {
        if (!fatalPartError) {
            return;
        }
        console.error(
            '[Upload] Aborting read loop — a part failed permanently:',
            fatalPartError.message,
        );
        drainPendingQueue();
        flushComplete = true;
        resolveAllDone();
        throw buildPartFailureError();
    };

    let currentPartIndex = 0;
    let currentPartData: Uint8Array[] = [];
    let currentPartSize = 0;
    let leftoverData: Uint8Array | null = null;

    try {
        let streamDone = false;

        while (currentPartIndex < parts.length) {
            throwIfPartFailedPermanently();
            if (canceller.cancelled) {
                throw new Error('Upload cancelled');
            }
            const part = parts[currentPartIndex];

            // Add leftover data from previous part (skip if empty)
            if (leftoverData && leftoverData.length > 0) {
                currentPartData.push(leftoverData);
                currentPartSize += leftoverData.length;
                leftoverData = null;
            } else {
                leftoverData = null;
            }

            // Read data for this part
            // For the last allocated part, drain ALL remaining stream data (trailing part absorbs excess)
            const isLastAllocatedPart = currentPartIndex >= parts.length - 1;
            while (!streamDone && (isLastAllocatedPart || currentPartSize < effectivePartSize)) {
                // Safety cap: prevent unbounded memory on the trailing part
                if (isLastAllocatedPart && currentPartSize >= MAX_PART_SIZE) {
                    console.error(
                        `[Upload] Trailing part exceeded MAX_PART_SIZE (${MAX_PART_SIZE}), stopping read`,
                    );
                    break;
                }

                const { done, value } = await reader.read();

                if (done) {
                    streamDone = true;
                    break;
                }

                if (canceller.cancelled) {
                    throw new Error('Upload cancelled');
                }

                throwIfPartFailedPermanently();

                // Skip empty chunks — WebKit/Safari can emit Uint8Array(0) between
                // internal buffer refills, which would create 0-byte parts
                if (value.length === 0) {
                    continue;
                }

                const wouldExceed = currentPartSize + value.length > effectivePartSize;

                if (wouldExceed && !isLastAllocatedPart) {
                    const remainingSpace = effectivePartSize - currentPartSize;
                    if (remainingSpace > 0) {
                        currentPartData.push(value.slice(0, remainingSpace));
                        currentPartSize += remainingSpace;
                        leftoverData = value.slice(remainingSpace);
                    } else {
                        leftoverData = value;
                    }
                    break;
                } else {
                    currentPartData.push(value);
                    currentPartSize += value.length;
                }
            }

            // Buffer part if we have actual bytes (not just empty chunk entries)
            if (currentPartSize > 0) {
                const partBlob = new Blob(currentPartData as BlobPart[]);
                currentPartData = [];
                currentPartSize = 0;

                queueOrBuffer(partBlob, part.partNumber, part.url);

                // Backpressure: wait if we have too many parts buffered
                const maxBuffered = maxConcurrent + 1;
                if (pendingQueue.length + activeUploads >= maxBuffered) {
                    await new Promise<void>((resolve) => {
                        const checkRoom = setInterval(() => {
                            // Cancellation and permanent failure both stop new
                            // parts from starting, so never park here for them
                            if (
                                canceller.cancelled ||
                                fatalPartError ||
                                pendingQueue.length + activeUploads < maxBuffered
                            ) {
                                clearInterval(checkRoom);
                                resolve();
                            }
                        }, 50);
                    });
                }
            } else if (streamDone) {
                break;
            }

            currentPartIndex++;
        }

        // Assert stream was fully consumed — with the trailing part drain fix,
        // this should always be true. If not, there's a logic bug causing data loss.
        if (!streamDone) {
            const diagnostic = {
                currentPartIndex,
                totalParts: parts.length,
                partSize,
                totalFileSize,
                uploadId: uploadInfo.uploadId,
            };
            console.error(
                '[Upload] CRITICAL: Stream not fully consumed after read loop!',
                diagnostic,
            );
            captureError(
                new Error('Stream not fully consumed: potential data loss in multipart upload'),
                {
                    operation: 'upload.stream-exhaustion',
                    extra: diagnostic,
                },
            );
            throw new Error('Upload failed: stream was not fully consumed. Please try again.');
        }

        // Stream is done — flush the buffered item
        // (bufferedItem is reassigned inside the queueOrBuffer closure, so TS can't narrow it)
        const finalBuffered = bufferedItem as { blob: Blob; partNum: number; url: string } | null;
        if (finalBuffered) {
            // Check if we only have 1 part total and it's too small for multipart.
            // On resume, parts from the previous session already exist at S3, so a
            // small blob here is a legal trailing part — never fall back.
            const noPriorParts = !isResume && totalPartsQueued === 0 && activeUploads === 0;

            if (noPriorParts && finalBuffered.blob.size < MIN_PART) {
                // Entire stream output is a single tiny blob — fallback to single-part upload
                console.log(
                    `[Upload] Stream produced only ${(finalBuffered.blob.size / 1024).toFixed(1)}KB — falling back to single-part upload`,
                );
                return { fallbackBlob: finalBuffered.blob };
            }

            // Check if final part is too small and we can merge it with a pending part
            if (finalBuffered.blob.size < MIN_PART && pendingQueue.length > 0) {
                // The merged part no longer holds exactly effectivePartSize bytes,
                // so the persisted resume math (skip offset = completed parts ×
                // part size) would resume from the wrong file offset and corrupt
                // the object. Drop resumability for this upload.
                //
                // discardUploadState marks the file ID non-resumable
                // SYNCHRONOUSLY, before the merge happens, so a later
                // updateCompletedPart can't win the race against the delete and
                // resurrect poisoned state (the delete itself is best-effort).
                if (fileId) {
                    discardUploadState(fileId);
                }

                // Merge with the last pending part
                const lastPending = pendingQueue[pendingQueue.length - 1];
                totalUploadedSize += finalBuffered.blob.size;
                const mergedBlob = new Blob([lastPending.blob, finalBuffered.blob]);
                console.log(
                    `[Upload] Merging small final part (${(finalBuffered.blob.size / 1024).toFixed(1)}KB) into part ${lastPending.partNum} (${(lastPending.blob.size / (1024 * 1024)).toFixed(1)}MB → ${(mergedBlob.size / (1024 * 1024)).toFixed(1)}MB)`,
                );
                lastPending.blob = mergedBlob;
                // Don't queue the tiny buffered item separately
            } else {
                // Final part is large enough, or no pending parts to merge with — queue it normally
                totalUploadedSize += finalBuffered.blob.size;
                totalPartsQueued++;
                pendingQueue.push(finalBuffered);
            }

            bufferedItem = null;
            processQueue();
        }

        // All parts are now known — allow resolveAllDone() to fire.
        flushComplete = true;

        // If every part already completed while we were flushing,
        // resolveAllDone() was suppressed by the guard.  Fire it now.
        if (totalPartsQueued > 0 && totalPartsFinished >= totalPartsQueued) {
            resolveAllDone();
        }

        // Wait for all uploads to complete
        if (totalPartsQueued > 0 && totalPartsFinished < totalPartsQueued) {
            console.log(
                `[Upload] Waiting for ${totalPartsQueued - totalPartsFinished} remaining uploads...`,
            );
            await allDonePromise;
        }

        if (canceller.cancelled) {
            throw new Error('Upload cancelled');
        }

        // Check for failures
        if (failedPartNumbers.length > 0) {
            throw buildPartFailureError();
        }

        console.log(`[Upload] All ${completedParts.length} parts completed successfully`);

        // Defensive assertion: ensure every queued part is accounted for.
        // This catches any residual race conditions where the completion call
        // could fire with fewer parts than R2 expects.
        if (completedParts.length + failedPartNumbers.length < totalPartsQueued) {
            const missing = totalPartsQueued - completedParts.length - failedPartNumbers.length;
            const diagnostic = {
                completedParts: completedParts.length,
                failedParts: failedPartNumbers.length,
                totalPartsQueued,
                totalPartsFinished,
                uploadId: uploadInfo.uploadId,
                partSize,
                totalFileSize,
            };
            console.error(
                '[Upload] CRITICAL: Part accounting mismatch — some parts unaccounted for',
                diagnostic,
            );
            captureError(new Error(`Part accounting mismatch: ${missing} parts unaccounted for`), {
                operation: 'upload.part-accounting',
                extra: diagnostic,
            });
            throw new Error('Upload failed: internal part tracking error. Please try again.');
        }

        // Pre-completion consistency check: verify all non-trailing parts have identical sizes
        // This is the key diagnostic for R2's "All non-trailing parts must have the same length" error
        const sortedPartNums = Object.keys(uploadedPartSizes)
            .map(Number)
            .sort((a, b) => a - b);
        if (sortedPartNums.length > 1) {
            const maxPartNum = Math.max(...sortedPartNums);
            const nonTrailingSizes = sortedPartNums
                .filter((pn) => pn !== maxPartNum)
                .map((pn) => ({ partNumber: pn, size: uploadedPartSizes[pn] }));

            const expectedNonTrailingSize = nonTrailingSizes[0]?.size;
            const inconsistentParts = nonTrailingSizes.filter(
                (p) => p.size !== expectedNonTrailingSize,
            );

            if (inconsistentParts.length > 0) {
                const diagnostic = {
                    expectedSize: expectedNonTrailingSize,
                    inconsistentParts,
                    allPartSizes: uploadedPartSizes,
                    uploadId: uploadInfo.uploadId,
                    partSize,
                    totalFileSize,
                    totalParts: sortedPartNums.length,
                };
                console.error(
                    '[Upload] CRITICAL: Non-trailing part size inconsistency detected!',
                    diagnostic,
                );
                const err = new Error(
                    `Non-trailing part size inconsistency: expected ${expectedNonTrailingSize}, found ${inconsistentParts.map((p) => `part ${p.partNumber}=${p.size}`).join(', ')}`,
                );
                captureError(err, {
                    operation: 'upload.part-size-consistency',
                    extra: {
                        expectedSize: expectedNonTrailingSize,
                        inconsistentParts: JSON.stringify(inconsistentParts),
                        allPartSizes: JSON.stringify(uploadedPartSizes),
                        uploadId: uploadInfo.uploadId,
                        partSize,
                        totalFileSize,
                        totalParts: sortedPartNums.length,
                    },
                });
                // Hard fail — R2 will reject this with "All non-trailing parts must have the same length"
                throw err;
            }
        }

        // Size mismatch telemetry: compare actual bytes consumed to the estimated total
        // The upload still works (trailing part absorbed excess), but mismatches help tune estimates
        if (totalFileSize !== undefined && totalUploadedSize !== totalFileSize) {
            const delta = totalUploadedSize - totalFileSize;
            const diagnostic = {
                estimatedSize: totalFileSize,
                actualSize: totalUploadedSize,
                delta,
                deltaPercent: ((delta / totalFileSize) * 100).toFixed(4),
                uploadId: uploadInfo.uploadId,
                totalParts: completedParts.length,
                partSize,
            };
            console.warn(
                `[Upload] Size mismatch: estimated ${totalFileSize}, actual ${totalUploadedSize} (delta: ${delta > 0 ? '+' : ''}${delta})`,
                diagnostic,
            );
            addBreadcrumb(
                `Size estimate mismatch: delta ${delta > 0 ? '+' : ''}${delta} bytes (${diagnostic.deltaPercent}%)`,
                {
                    category: 'upload',
                    data: diagnostic,
                    level: 'warning',
                },
            );
        }

        return {
            parts: completedParts.sort((a, b) => a.PartNumber - b.PartNumber),
            actualSize: totalUploadedSize,
        };
    } finally {
        reader.releaseLock();
    }
}

/**
 * Upload a single part with retry logic
 */
async function uploadPartWithRetry(
    blob: Blob,
    url: string,
    partNumber: number,
    onProgress: (loaded: number) => void,
    canceller: Canceller,
    retryCount = 0,
    onRetry?: () => void,
): Promise<{ PartNumber: number; ETag: string; bytesSent: number }> {
    try {
        return await uploadPart(blob, url, partNumber, onProgress, canceller);
    } catch (error: unknown) {
        if (canceller.cancelled) {
            throw error;
        }

        const err = error instanceof Error ? error : new Error(String(error));
        const isRetryable = isRetryableError(err);
        console.warn(
            `[Upload] Part ${partNumber} failed (attempt ${retryCount + 1}/${MAX_RETRIES + 1}): ${err.message}`,
            {
                retryable: isRetryable,
                blobSize: blob.size,
            },
        );

        if (retryCount < MAX_RETRIES && isRetryable) {
            await waitForOnline(canceller);

            // waitForOnline now returns on cancellation too — bail before
            // scheduling the backoff instead of parking on a dead retry
            if (canceller.cancelled) {
                throw new Error('Upload cancelled');
            }

            const delay = retryDelayMs(retryCount);

            console.log(`[Upload] Retrying part ${partNumber} in ${(delay / 1000).toFixed(1)}s...`);

            onRetry?.();

            await cancellableDelay(delay, canceller);

            if (canceller.cancelled) {
                throw new Error('Upload cancelled');
            }

            onProgress(0); // Reset progress
            return uploadPartWithRetry(
                blob,
                url,
                partNumber,
                onProgress,
                canceller,
                retryCount + 1,
                onRetry,
            );
        }

        captureError(err, {
            operation: 'upload.part.exhausted',
            extra: {
                partNumber,
                partSize: blob.size,
                retriesAttempted: retryCount,
                maxRetries: MAX_RETRIES,
                isRetryable: isRetryableError(err),
                errorMessage: err.message,
            },
        });
        throw err;
    }
}

/**
 * Upload a single part
 */
function uploadPart(
    blob: Blob,
    url: string,
    partNumber: number,
    onProgress: (loaded: number) => void,
    canceller: Canceller,
): Promise<{ PartNumber: number; ETag: string; bytesSent: number }> {
    // Never open a new request for a cancelled upload — Canceller.cancel() only
    // aborts the XHRs that existed at that instant
    if (canceller.cancelled) {
        return Promise.reject(new Error('Upload cancelled'));
    }
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        canceller.addXhr(xhr);

        let stallTimer: ReturnType<typeof setTimeout>;
        let stalledAbort = false;
        // Track actual bytes reported by XHR progress (detects truncated uploads
        // where iOS Safari's file.slice() produces fewer bytes than Blob.size)
        let lastProgressLoaded = 0;
        let progressTotal = blob.size;
        const resetStallTimer = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                stalledAbort = true;
                window.removeEventListener('offline', handleOffline);
                window.removeEventListener('online', handleOnline);
                xhr.abort();
                reject(new Error('Upload stalled'));
            }, STALL_TIMEOUT);
        };

        // Pause stall timer when offline
        const handleOffline = () => {
            clearTimeout(stallTimer);
        };
        const handleOnline = () => {
            resetStallTimer();
        };
        window.addEventListener('offline', handleOffline);
        window.addEventListener('online', handleOnline);

        xhr.upload.addEventListener('progress', (e) => {
            resetStallTimer();
            if (e.lengthComputable) {
                lastProgressLoaded = e.loaded;
                progressTotal = e.total;
                onProgress(e.loaded);
            }
        });

        xhr.addEventListener('loadstart', resetStallTimer);

        xhr.addEventListener('loadend', () => {
            clearTimeout(stallTimer);
            window.removeEventListener('offline', handleOffline);
            window.removeEventListener('online', handleOnline);
            canceller.removeXhr(xhr);

            if (xhr.status >= 200 && xhr.status < 300) {
                const etag = xhr.getResponseHeader('ETag');
                if (!etag) {
                    // Without the ETag, CompleteMultipartUpload is guaranteed to
                    // fail with InvalidPart after every byte has been uploaded.
                    // This is a bucket CORS misconfiguration (ETag missing from
                    // ExposeHeaders) — fail fast with an actionable error.
                    const err = new Error(
                        `Part ${partNumber} uploaded but the ETag response header is not visible — check the bucket CORS ExposeHeaders configuration`,
                    );
                    captureError(err, {
                        operation: 'upload.part.missing-etag',
                        extra: { partNumber, blobSize: blob.size },
                    });
                    reject(err);
                    return;
                }
                // Use progressTotal as the definitive byte count — if the browser
                // determined a different Content-Length than blob.size (e.g. iOS
                // transcoding changed actual file bytes), progressTotal reflects
                // what was actually sent to the server.
                const bytesSent = lastProgressLoaded > 0 ? progressTotal : blob.size;
                resolve({ PartNumber: partNumber, ETag: etag, bytesSent });
            } else if (!stalledAbort) {
                // Skip error reporting if this was an intentional stall abort
                // (the stall timer already rejected with 'Upload stalled')
                let errorDetails = `HTTP ${xhr.status}`;
                if (xhr.statusText) {
                    errorDetails += ` (${xhr.statusText})`;
                }
                if (xhr.responseText) {
                    errorDetails += `: ${xhr.responseText.substring(0, 200)}`;
                }
                const err = new Error(errorDetails);
                captureError(err, {
                    operation: 'upload.part.http',
                    extra: {
                        partNumber,
                        httpStatus: xhr.status,
                        statusText: xhr.statusText,
                        blobSize: blob.size,
                        responsePreview: xhr.responseText?.substring(0, 200),
                    },
                    level: 'warning',
                });
                reject(err);
            }
        });

        xhr.addEventListener('error', () => {
            clearTimeout(stallTimer);
            window.removeEventListener('offline', handleOffline);
            window.removeEventListener('online', handleOnline);
            canceller.removeXhr(xhr);
            reject(new Error('Network error'));
        });

        xhr.open('PUT', url);
        xhr.send(blob);
    });
}

/**
 * Release the server-side allocation for an upload that will never complete.
 *
 * /upload/abort/:id requires a multipart uploadId, which single-part uploads
 * don't have, so the owner-token delete is the only way to drop the Redis
 * metadata and decrement the provider file counter.
 */
async function releaseUploadAllocation(id: string, ownerToken: string): Promise<void> {
    if (!id || !ownerToken) {
        return;
    }
    try {
        await fetch(`${API_BASE_URL}/delete/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner_token: ownerToken }),
        });
    } catch (e) {
        console.warn('[Upload] Failed to release upload allocation:', e);
        captureError(e, {
            operation: 'upload.release-allocation',
            extra: { fileId: id },
            level: 'warning',
        });
    }
}

/**
 * Abort a multipart upload
 */
async function abortMultipartUpload(
    id: string,
    uploadId: string,
    uploadToken?: string,
): Promise<void> {
    try {
        const response = await fetch(`${API_BASE_URL}/upload/abort/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // uploadToken authorizes the abort (audit #52). Omitted for records
            // written before it was persisted; the backend accepts those.
            body: JSON.stringify(uploadToken ? { uploadId, uploadToken } : { uploadId }),
        });
        // A non-ok abort used to be swallowed, so a 500 left the server-side
        // multipart orphaned while the client believed it had cleaned up.
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Abort failed: HTTP ${response.status} ${detail}`.trim());
        }
    } catch (e) {
        console.warn('Failed to abort multipart upload:', e);
        captureError(e, {
            operation: 'upload.abort',
            extra: { fileId: id, uploadId },
            level: 'warning',
        });
    }
}

/**
 * Fetch with retry logic
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
    let lastError: Error | null = null;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            return response;
        } catch (e: unknown) {
            lastError = e instanceof Error ? e : new Error(String(e));
            if (i < retries - 1) {
                await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
            }
        }
    }

    const err = lastError || new Error('Fetch failed');
    captureError(err, {
        operation: 'fetch.retry',
        extra: {
            urlPath: new URL(url).pathname,
            retries,
            lastErrorMessage: err.message,
        },
        level: 'warning',
    });
    throw err;
}

/**
 * Report a completed download to the server so download limits are enforced.
 * Mirrors getMetadata's 401 challenge-response pattern, retries once on pure
 * network errors, and never throws — returns false on failure.
 */
export async function reportDownloadComplete(
    id: string,
    keychain: Keychain | null,
): Promise<boolean> {
    const post = async (): Promise<Response> => {
        const headers: Record<string, string> = {};
        if (keychain) {
            headers.Authorization = await keychain.authHeader();
        }
        return fetch(`${API_BASE_URL}/download/complete/${id}`, { method: 'POST', headers });
    };

    let response: Response;
    try {
        // No blind retry on network error: the server may have processed the
        // increment before the response was lost, and /download/complete is
        // not idempotent — a retry could double-count the download.
        response = await post();

        // Handle 401 challenge-response: harvest nonce, re-sign, retry once
        // (safe: a 401 response proves the counter was not incremented)
        if (response.status === 401 && keychain) {
            const wwwAuth = response.headers.get('WWW-Authenticate');
            const nonce = wwwAuth?.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
                response = await post();
            }
        }
    } catch (e) {
        captureError(e, {
            operation: 'download.complete',
            extra: { fileId: id },
            level: 'warning',
        });
        return false;
    }

    // Harvest the rotated nonce from the final response
    if (keychain) {
        const wwwAuth = response.headers.get('WWW-Authenticate');
        const nonce = wwwAuth?.split(' ')[1];
        if (nonce) {
            keychain.nonce = nonce;
        }
    }

    if (!response.ok) {
        captureError(new Error(`Failed to report download complete: HTTP ${response.status}`), {
            operation: 'download.complete',
            extra: { fileId: id, httpStatus: response.status },
            level: 'warning',
        });
        return false;
    }
    return true;
}

/**
 * Fetch with a stall guard around the connection/response-header phase.
 *
 * Browsers impose no default fetch timeout, so a socket that connects but
 * never returns headers (blackholed proxy, captive portal, dead middlebox)
 * parks the await forever. The body-side stall detector cannot help — it only
 * arms once a reader exists. This aborts the request if no response headers
 * arrive within `timeoutMs`, then clears the timer the moment they do so body
 * transfer is never capped by it.
 *
 * Pass an existing `controller` to keep the caller's ability to abort the
 * in-flight body later (the resilient stream does exactly this).
 */
export async function fetchWithHeaderTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    controller: AbortController = new AbortController(),
): Promise<Response> {
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
        if (timedOut) {
            throw new Error(`Timed out waiting for response headers after ${timeoutMs}ms`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fetch the download URL info for a file, handling the 401 challenge-response
 * pattern for encrypted files. Throws on non-ok responses.
 */
async function fetchDownloadUrlInfo(
    id: string,
    keychain: Keychain | null,
): Promise<{ useSignedUrl: boolean; url: string; dl?: number; dlimit?: number }> {
    const headers: Record<string, string> = {};
    if (keychain) {
        headers.Authorization = await keychain.authHeader();
    }

    let response = await fetchWithHeaderTimeout(
        `${API_BASE_URL}/download/url/${id}`,
        { headers },
        DOWNLOAD_STALL_TIMEOUT,
    );

    // Handle 401 challenge-response: extract nonce and retry
    if (response.status === 401 && keychain) {
        const authHeader = response.headers.get('WWW-Authenticate');
        if (authHeader) {
            const nonce = authHeader.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
                headers.Authorization = await keychain.authHeader();
                response = await fetchWithHeaderTimeout(
                    `${API_BASE_URL}/download/url/${id}`,
                    { headers },
                    DOWNLOAD_STALL_TIMEOUT,
                );
            }
        }
    }

    // Extract nonce for future requests
    if (keychain) {
        const authHeader = response.headers.get('WWW-Authenticate');
        if (authHeader) {
            const nonce = authHeader.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
            }
        }
    }

    if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        captureError(err, {
            operation: 'download.url-fetch',
            extra: { fileId: id, httpStatus: response.status, encrypted: !!keychain },
        });
        throw err;
    }

    return response.json();
}

export class PermanentDownloadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PermanentDownloadError';
    }
}

/**
 * Raised when `controller.enqueue`/`controller.close` throws because the
 * stream is already closed or errored — i.e. the consumer went away (a
 * downstream decryption TransformStream errored and cancelled us). Retrying
 * the network can never fix this, so it is strictly terminal.
 *
 * It must be a distinct type: the raw failure is a `TypeError`, which is also
 * what a genuine `fetch()` network failure throws, and those MUST stay
 * retryable.
 */
export class StreamConsumerGoneError extends Error {
    constructor(operation: 'enqueue' | 'close', cause: unknown) {
        super(`Download stream consumer is gone (${operation} failed)`);
        this.name = 'StreamConsumerGoneError';
        this.cause = cause;
    }
}

/**
 * Decide whether a failed pull attempt is worth retrying. Pure, so the retry
 * policy is unit-testable without a network.
 *
 * Terminal cases: a 404/410 from the object store, a consumer that has gone
 * away, and an exhausted retry budget. Everything else (socket resets, stalls,
 * `fetch` TypeErrors) is retryable.
 */
export function shouldRetryDownloadAttempt(
    error: unknown,
    state: { failures: number; maxRetries: number },
): boolean {
    if (error instanceof PermanentDownloadError || error instanceof StreamConsumerGoneError) {
        return false;
    }
    return state.failures < state.maxRetries;
}

/**
 * True when a range-resume attempt is pointless because every byte of the
 * object has already been received.
 *
 * A connection that dies holding EOF/FIN leaves `received === total`; the
 * retry would ask for `Range: bytes=<total>-`, which is unsatisfiable, and
 * S3/R2 answer 416 — discarding a byte-complete download. The total is taken
 * from the first response's Content-Length when known, otherwise from the
 * `bytes * /N` Content-Range that a 416 carries.
 */
export function isRangeResumeUnnecessary(
    received: number,
    expectedTotal?: number,
    unsatisfiableContentRange?: string | null,
): boolean {
    if (expectedTotal !== undefined && expectedTotal > 0 && received >= expectedTotal) {
        return true;
    }
    if (unsatisfiableContentRange) {
        const match = /^bytes\s+\*\/(\d+)$/.exec(unsatisfiableContentRange.trim());
        if (match) {
            const total = parseInt(match[1], 10);
            return Number.isFinite(total) && total > 0 && received >= total;
        }
    }
    return false;
}

export interface ResilientDownloadRequest {
    url: string;
    headers?: Record<string, string>;
}

export interface ResilientDownloadOptions {
    /**
     * Returns the URL + headers for the object body. Called with
     * refreshUrl=true when the current signed URL was rejected as
     * expired (403) and a fresh one should be requested.
     */
    getRequest: (refreshUrl: boolean) => Promise<ResilientDownloadRequest>;
    /**
     * Invoked with every response received while (re)opening an attempt,
     * before status handling — lets the caller harvest rotated auth nonces
     * from WWW-Authenticate so re-signed retries stay valid.
     */
    onResponse?: (response: Response) => void;
    /** Already-fetched response to consume for the first attempt */
    firstResponse?: Response;
    /**
     * Total wire size of the object, when known (the first response's
     * Content-Length). Once `received` reaches it the stream closes as
     * complete instead of issuing an unsatisfiable range-resume request.
     */
    expectedTotal?: number;
    maxRetries?: number;
    retryDelays?: number[];
    stallTimeout?: number;
}

/**
 * Produce a continuous ReadableStream over a remote object that survives
 * mid-stream network failures. On failure it retries with exponential backoff
 * (waiting for connectivity when offline) and resumes from the total bytes
 * already delivered via a Range request. Servers without range support (200
 * response) have the already-received prefix discarded. A stall detector
 * aborts the in-flight fetch if no bytes arrive within stallTimeout, and the
 * connection/response-header phase carries the same guard.
 * The retry budget resets whenever an attempt successfully delivers new bytes
 * downstream. Cancellation is terminal: no attempt is opened afterwards.
 */
export function createResilientDownloadStream(
    options: ResilientDownloadOptions,
): ReadableStream<Uint8Array> {
    const maxRetries = options.maxRetries ?? DOWNLOAD_MAX_RETRIES;
    const retryDelays = options.retryDelays ?? DOWNLOAD_RETRY_DELAYS;
    const stallTimeout = options.stallTimeout ?? DOWNLOAD_STALL_TIMEOUT;
    const expectedTotal = options.expectedTotal;

    let received = 0;
    let failures = 0;
    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let abortController: AbortController | null = null;
    let discardRemaining = 0;
    let firstResponse = options.firstResponse ?? null;

    const dropAttempt = () => {
        reader?.cancel().catch(() => {
            // Intentionally ignored — attempt is being discarded
        });
        reader = null;
        abortController?.abort();
        abortController = null;
    };

    const classifyResponse = (response: Response): void => {
        if (response.status === 404 || response.status === 410) {
            throw new PermanentDownloadError(`Download failed: HTTP ${response.status}`);
        }
    };

    // 'complete' means every byte already arrived and no attempt is needed.
    const openAttempt = async (): Promise<'opened' | 'complete'> => {
        discardRemaining = 0;
        abortController = new AbortController();

        if (received === 0 && firstResponse) {
            const response = firstResponse;
            firstResponse = null;
            if (!response.body) {
                throw new Error('No response body');
            }
            reader = response.body.getReader();
            return 'opened';
        }

        // A connection that dropped while holding EOF leaves us byte-complete;
        // resuming would request an unsatisfiable range and throw away a
        // finished download.
        if (isRangeResumeUnnecessary(received, expectedTotal)) {
            return 'complete';
        }

        const doFetch = async (refreshUrl: boolean): Promise<Response> => {
            const request = await options.getRequest(refreshUrl);
            const headers: Record<string, string> = { ...request.headers };
            if (received > 0) {
                headers.Range = `bytes=${received}-`;
            }
            const controller = abortController ?? new AbortController();
            return fetchWithHeaderTimeout(request.url, { headers }, stallTimeout, controller);
        };

        let response = await doFetch(false);
        options.onResponse?.(response);
        if (response.status === 403) {
            // Signed URL expired — request a fresh one and retry immediately
            response = await doFetch(true);
            options.onResponse?.(response);
        } else if (response.status === 401) {
            // Stale auth nonce on the authenticated fallback path — the
            // challenge was just harvested by onResponse; re-sign and retry
            response = await doFetch(false);
            options.onResponse?.(response);
        }
        classifyResponse(response);

        if (received > 0) {
            if (response.status === 206) {
                const contentRange = response.headers.get('Content-Range') || '';
                const startMatch = /^bytes (\d+)-/.exec(contentRange);
                const start = startMatch ? parseInt(startMatch[1], 10) : -1;
                if (start !== received) {
                    throw new Error(
                        `Range resume mismatch: requested offset ${received}, got Content-Range "${contentRange}"`,
                    );
                }
            } else if (response.status === 200) {
                // Server ignored the Range header — discard the prefix we already have
                discardRemaining = received;
            } else if (
                response.status === 416 &&
                isRangeResumeUnnecessary(
                    received,
                    expectedTotal,
                    response.headers.get('Content-Range'),
                )
            ) {
                // Unsatisfiable range because there is nothing left to fetch —
                // the object is already fully received.
                return 'complete';
            } else {
                throw new Error(`Range resume failed: HTTP ${response.status}`);
            }
        } else if (!response.ok) {
            throw new Error(`Download failed: HTTP ${response.status}`);
        }

        if (!response.body) {
            throw new Error('No response body');
        }
        reader = response.body.getReader();
        return 'opened';
    };

    // Race a read against the stall timer; on stall, abort the in-flight
    // fetch so the read rejects and the attempt is retried.
    const readWithStallGuard = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (!reader) {
            throw new Error('No active download attempt');
        }
        const controller = abortController;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                reader.read(),
                new Promise<never>((_, reject) => {
                    stallTimer = setTimeout(() => {
                        controller?.abort();
                        reject(new Error('Download stalled'));
                    }, stallTimeout);
                }),
            ]);
        } finally {
            clearTimeout(stallTimer);
        }
    };

    // Any throw from enqueue/close means the stream is closed or errored — the
    // consumer is gone. Tag it so the retry loop cannot mistake it for a
    // transient network fault and refetch forever.
    const enqueueChunk = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        chunk: Uint8Array,
    ) => {
        try {
            controller.enqueue(chunk);
        } catch (e) {
            throw new StreamConsumerGoneError('enqueue', e);
        }
    };

    const closeStream = (controller: ReadableStreamDefaultController<Uint8Array>) => {
        try {
            controller.close();
        } catch (e) {
            throw new StreamConsumerGoneError('close', e);
        }
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            while (true) {
                // Cancellation is checked on every loop entry, not just on the
                // first: each `await` below is a point where cancel() can land.
                if (cancelled) {
                    return;
                }
                try {
                    if (!reader && (await openAttempt()) === 'complete') {
                        closeStream(controller);
                        return;
                    }
                    const { done, value } = await readWithStallGuard();
                    if (done || !value) {
                        closeStream(controller);
                        return;
                    }

                    let chunk = value;
                    if (discardRemaining > 0) {
                        if (chunk.length <= discardRemaining) {
                            discardRemaining -= chunk.length;
                            continue;
                        }
                        chunk = chunk.subarray(discardRemaining);
                        discardRemaining = 0;
                    }
                    if (chunk.length === 0) {
                        continue;
                    }

                    received += chunk.length;
                    enqueueChunk(controller, chunk);
                    // Reset the retry budget only once bytes actually reached
                    // the consumer. Resetting before the enqueue meant a
                    // permanently failing enqueue never exhausted maxRetries.
                    failures = 0;
                    return;
                } catch (e) {
                    dropAttempt();
                    if (cancelled) {
                        // Nobody is listening; erroring the stream here would
                        // only produce an unhandled rejection.
                        return;
                    }
                    if (!shouldRetryDownloadAttempt(e, { failures, maxRetries })) {
                        throw e instanceof Error ? e : new Error(String(e));
                    }
                    const delay = retryDelays[Math.min(failures, retryDelays.length - 1)];
                    failures++;
                    console.warn(
                        `[Download] Stream attempt failed (${failures}/${maxRetries}), resuming from byte ${received} in ${delay}ms:`,
                        e,
                    );
                    await waitForOnline();
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        },
        cancel() {
            cancelled = true;
            dropAttempt();
        },
    });
}

/**
 * Wire length the server advertised for a response body, or 0 when unknown.
 *
 * Prefers `X-Object-Content-Length` over `Content-Length`. The backend's
 * fallback stream routes (`GET /download/:id`, `/download/blob/:id`) cannot
 * advertise a real `Content-Length`: Bun serialises every streamed body as
 * `transfer-encoding: chunked` and drops an explicit `Content-Length`, so those
 * responses would read as length 0 and skip the only hard truncation guard
 * below — a severed transfer would be saved as a complete-looking, corrupt
 * file. The custom header survives that serialisation and carries the object's
 * true size from S3 (`GetObject` `ContentLength`); it is CORS-exposed by the
 * backend. Signed-URL downloads straight from S3 keep using `Content-Length`.
 */
export function advertisedBodyLength(response: Response): number {
    for (const header of ['X-Object-Content-Length', 'Content-Length']) {
        const raw = response.headers.get(header);
        if (raw === null) {
            continue;
        }
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }
    return 0;
}

/**
 * Download a file
 */
export type DownloadPhase = 'downloading' | 'decrypting' | 'finalizing';

/**
 * Open the save target, dropping the in-flight transfer if none can be opened.
 *
 * The writer is opened before any bytes are consumed so an oversized or
 * declined save is refused up front rather than after gigabytes have been
 * pulled down. When it does refuse, the response stream is already attached, so
 * cancel it instead of leaking the connection.
 */
async function openSaveTarget(
    options: DownloadWriterOptions,
    upstream: ReadableStream<Uint8Array>,
): Promise<DownloadWriter> {
    try {
        return await createDownloadWriter(options);
    } catch (e) {
        void upstream.cancel().catch(() => {
            // Already cancelled or errored — the transfer is gone either way.
        });
        throw e;
    }
}

/**
 * Drain a stream into a save target, discarding the partial file on failure so
 * a truncated download is never left behind.
 */
async function pumpToWriter(
    stream: ReadableStream<Uint8Array>,
    writer: DownloadWriter,
    onError: (e: unknown, written: number) => never,
): Promise<number> {
    const reader = stream.getReader();
    let written = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value.length === 0) {
                continue;
            }
            written += value.length;
            await writer.write(value);
        }
    } catch (e) {
        await writer.abort(e);
        onError(e, written);
    }
    return written;
}

export async function downloadFile(
    id: string,
    keychain: Keychain | null,
    onProgress?: (loaded: number, total: number) => void,
    onPhase?: (phase: DownloadPhase) => void,
): Promise<{ blob: Blob; filename: string }> {
    const dlStart = Date.now();
    const dlLog = (msg: string, data?: Record<string, unknown>) =>
        console.log(`[Download] ${msg}`, data ? data : '');

    dlLog('Starting', { fileId: id, encrypted: !!keychain });
    addBreadcrumb('downloadFile called', {
        category: 'download',
        data: { fileId: id, encrypted: !!keychain },
    });

    // Get metadata first
    dlLog('Fetching metadata...');
    const metaStart = Date.now();
    const metadata = await getMetadata(id, keychain || undefined);
    dlLog('Metadata received', {
        elapsed: Date.now() - metaStart,
        name: metadata.name,
        size: metadata.size,
        encrypted: metadata.encrypted,
        zipped: metadata.zipped,
        fileCount: metadata.files?.length,
    });

    // Get download URL
    const urlData = await fetchDownloadUrlInfo(id, keychain);

    // At the download limit the backend deliberately answers with a soft 200
    // carrying the counters (documented tradeoff) rather than a 410, so the
    // client must gate on them. Falling through would hit /download/:id, which
    // hard-410s (or 404s once the file is deleted) and surfaces as a generic
    // retryable "HTTP 410"/"HTTP 404" plus a spurious error report.
    if (
        typeof urlData.dl === 'number' &&
        typeof urlData.dlimit === 'number' &&
        urlData.dlimit > 0 &&
        urlData.dl >= urlData.dlimit
    ) {
        dlLog('Download limit reached', { dl: urlData.dl, dlimit: urlData.dlimit });
        throw new LimitReachedError();
    }

    dlLog('Got download URL', {
        useSignedUrl: urlData.useSignedUrl,
        urlLength: urlData.url?.length,
    });

    // Download from signed URL or stream
    let downloadUrl = urlData.useSignedUrl ? urlData.url : `${API_BASE_URL}/download/${id}`;
    let usingSignedUrl = urlData.useSignedUrl;
    const downloadHeaders: Record<string, string> = {};

    if (!urlData.useSignedUrl && keychain) {
        downloadHeaders.Authorization = await keychain.authHeader();
    }

    // Header-phase guard only: the timer is cleared the moment headers arrive,
    // so the body (the actual download, potentially hours long) is never
    // capped — the read-side stall detector takes over from there.
    let response = await fetchWithHeaderTimeout(
        downloadUrl,
        { headers: downloadHeaders },
        DOWNLOAD_STALL_TIMEOUT,
    );

    // Handle 401 challenge-response for direct downloads
    if (response.status === 401 && keychain && !urlData.useSignedUrl) {
        const authHeader = response.headers.get('WWW-Authenticate');
        if (authHeader) {
            const nonce = authHeader.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
                downloadHeaders.Authorization = await keychain.authHeader();
                response = await fetchWithHeaderTimeout(
                    downloadUrl,
                    { headers: downloadHeaders },
                    DOWNLOAD_STALL_TIMEOUT,
                );
            }
        }
    }

    // Extract nonce for future requests
    if (keychain && !urlData.useSignedUrl) {
        const authHeader = response.headers.get('WWW-Authenticate');
        if (authHeader) {
            const nonce = authHeader.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
            }
        }
    }

    if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        captureError(err, {
            operation: 'download.fetch',
            extra: {
                fileId: id,
                httpStatus: response.status,
                encrypted: !!keychain,
                contentLength: parseInt(response.headers.get('Content-Length') || '0', 10),
                usedSignedUrl: urlData.useSignedUrl,
            },
        });
        throw err;
    }

    // Stream with progress
    const contentLength = advertisedBodyLength(response);

    if (!response.body) {
        throw new Error('No response body');
    }

    // Progress total is in wire bytes: prefer Content-Length; otherwise derive
    // the encrypted wire size from the plaintext size rather than conflating them.
    const total =
        contentLength > 0
            ? contentLength
            : metadata.encrypted
              ? calculateEncryptedSize(metadata.size)
              : metadata.size;
    const files = metadata.files as FileInfo[] | undefined;
    const isLegacyMultiFile = !metadata.zipped && files && files.length > 1;

    // Resilient body transfer: survives mid-stream network failures by
    // resuming from the received offset (refreshing the signed URL if expired).
    // Created before the legacy branch so both paths get the same resilience.
    const bodyStream = createResilientDownloadStream({
        firstResponse: response,
        // Lets a resume that already holds every byte close as complete
        // instead of issuing an unsatisfiable Range and 416-ing the download
        // away. Absent (0) on the fallback route, which sends no Content-Length.
        expectedTotal: contentLength > 0 ? contentLength : undefined,
        getRequest: async (refreshUrl) => {
            if (refreshUrl) {
                const fresh = await fetchDownloadUrlInfo(id, keychain);
                usingSignedUrl = fresh.useSignedUrl;
                downloadUrl = fresh.useSignedUrl ? fresh.url : `${API_BASE_URL}/download/${id}`;
            }
            const requestHeaders: Record<string, string> = {};
            if (!usingSignedUrl && keychain) {
                requestHeaders.Authorization = await keychain.authHeader();
            }
            return { url: downloadUrl, headers: requestHeaders };
        },
        onResponse: (res) => {
            if (!usingSignedUrl && keychain) {
                const nonce = res.headers.get('WWW-Authenticate')?.split(' ')[1];
                if (nonce) {
                    keychain.nonce = nonce;
                }
            }
        },
    });

    // Legacy multi-file path requires full buffer for slicing concatenated data
    if (isLegacyMultiFile && files) {
        return downloadFileLegacyMultiFile(
            id,
            bodyStream,
            contentLength,
            metadata,
            keychain,
            files,
            onProgress,
            onPhase,
        );
    }

    // Streaming path: pipe response directly through decryption, collect into
    // intermediate Blobs (which browsers can back with disk) to avoid buffering
    // the entire file multiple times in JS heap memory.
    onPhase?.('downloading');
    dlLog('Starting streaming download', {
        contentLength,
        encrypted: metadata.encrypted,
        metadataSize: metadata.size,
    });

    let loaded = 0;
    const streamStart = Date.now();
    let lastLogTime = streamStart;

    const progressStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            loaded += chunk.length;
            if (total > 0) {
                onProgress?.(Math.min(loaded, total), total);
            }

            const now = Date.now();
            if (now - lastLogTime > 5000) {
                const elapsed = Math.max((now - streamStart) / 1000, 0.001);
                dlLog('Download progress', {
                    loaded,
                    total: contentLength,
                    percentage: contentLength ? Math.round((loaded / contentLength) * 100) : '?',
                    elapsed: `${elapsed.toFixed(1)}s`,
                    speed: `${(loaded / (1024 * 1024) / elapsed).toFixed(1)} MB/s`,
                });
                lastLogTime = now;
            }

            controller.enqueue(chunk);
        },
    });

    let outputStream: ReadableStream<Uint8Array>;

    // In the streaming path, decryption happens concurrently with download —
    // there is no separate 'decrypting' phase. The 'decrypting' phase is only
    // emitted by the legacy multi-file fallback where buffered decryption is required.
    if (metadata.encrypted && keychain) {
        const decryptStream = createDecryptionStream(keychain, {
            eceVersion: readEceVersion(metadata),
        });
        outputStream = bodyStream.pipeThrough(progressStream).pipeThrough(decryptStream);
    } else {
        outputStream = bodyStream.pipeThrough(progressStream);
    }

    // Write decrypted output straight to disk as it arrives. Accumulating it
    // into Blobs bounded JS heap but not total retained bytes, so an encrypted
    // file far below the advertised maximum could crash the tab before the
    // save even started. The writer streams via the File System Access API or
    // a service-worker download stream; buffering in memory is a last resort
    // that is size-capped and warns first.
    const outputFilename = metadata.zipped
        ? metadata.zipFilename || generateZipFilename(files || [])
        : metadata.name || 'download';
    const outputMimeType = metadata.zipped ? 'application/zip' : undefined;
    const writer = await openSaveTarget(
        {
            filename: outputFilename,
            mimeType: outputMimeType,
            expectedSize: metadata.size > 0 ? metadata.size : total,
        },
        outputStream,
    );
    dlLog('Save target ready', { strategy: writer.strategy, filename: outputFilename });

    const decryptedSize = await pumpToWriter(outputStream, writer, (e, written) => {
        const message = e instanceof Error ? e.message : String(e);
        captureError(e, {
            operation: 'download.stream',
            extra: {
                fileId: id,
                encrypted: metadata.encrypted,
                bytesDownloaded: loaded,
                bytesDecrypted: written,
                saveStrategy: writer.strategy,
                errorMessage: message,
            },
        });
        throw new Error(`Download stream failed: ${message}`);
    });

    const streamElapsed = Math.max(Date.now() - streamStart, 1);
    dlLog('Streaming download complete', {
        downloadedBytes: loaded,
        decryptedBytes: decryptedSize,
        saveStrategy: writer.strategy,
        elapsed: `${(streamElapsed / 1000).toFixed(1)}s`,
        speed: `${(loaded / (1024 * 1024) / (streamElapsed / 1000)).toFixed(1)} MB/s`,
    });

    // Integrity checks: fail loudly on truncation instead of returning a
    // partial file and burning a download credit. They run before the commit,
    // so a failure has to tear the writer down itself — nothing else would.
    try {
        if (contentLength > 0 && loaded !== contentLength) {
            throw new Error(
                `Download incomplete: received ${loaded} of ${contentLength} bytes. Please try again.`,
            );
        }
        const isSinglePayload = !metadata.zipped && (!files || files.length <= 1);

        // Defence-in-depth for the no-Content-Length fallback stream route: the
        // guard above cannot fire, and an unencrypted payload carries no ECE
        // authentication either, so a severed upstream would otherwise be saved
        // as a truncated file with a download credit burned. The declared
        // plaintext size is the only truncation signal left, so here it is
        // enforced rather than merely reported.
        if (
            contentLength === 0 &&
            isSinglePayload &&
            !metadata.encrypted &&
            metadata.size > 0 &&
            loaded !== metadata.size
        ) {
            throw new Error(
                `Download incomplete: received ${loaded} of ${metadata.size} bytes. Please try again.`,
            );
        }

        // Plaintext size can legitimately differ from metadata (iOS lazily
        // transcodes HEIC/HEVC after File.size is read), so a mismatch here is
        // telemetry, not failure — real truncation is caught by the
        // Content-Length check above and by ECE record authentication.
        if (isSinglePayload && metadata.size > 0) {
            const expectedPlaintext = metadata.size;
            const actualPlaintext = metadata.encrypted ? decryptedSize : loaded;
            if (actualPlaintext !== expectedPlaintext) {
                captureError(
                    new Error(
                        `Download size mismatch: metadata says ${expectedPlaintext} bytes, received ${actualPlaintext}`,
                    ),
                    {
                        operation: 'download.size-mismatch',
                        extra: {
                            fileId: id,
                            expectedPlaintext,
                            actualPlaintext,
                            encrypted: metadata.encrypted,
                        },
                        level: 'warning',
                    },
                );
            }
        }
    } catch (e) {
        await writer.abort(e);
        throw e;
    }

    // Commit the save BEFORE burning a download credit. Reporting completion
    // first meant an OOM or a failed save consumed one of the file's limited
    // downloads while delivering nothing.
    onPhase?.('finalizing');
    dlLog('Committing save', { strategy: writer.strategy, filename: outputFilename });
    await writer.close();

    dlLog('Reporting download complete to server...');
    await reportDownloadComplete(id, keychain);

    const totalElapsed = Date.now() - dlStart;
    dlLog('Download complete', {
        filename: outputFilename,
        size: decryptedSize,
        sizeMB: Math.round((decryptedSize / (1024 * 1024)) * 10) / 10,
        saveStrategy: writer.strategy,
        totalElapsed: `${(totalElapsed / 1000).toFixed(1)}s`,
    });
    // The bytes are already on disk (or, for the buffered fallback, already
    // handed to the browser). The placeholder tells triggerDownload not to
    // save an empty second copy over the real file.
    return {
        blob: savedToDiskPlaceholder(),
        filename: outputFilename,
    };
}

/**
 * Legacy fallback for multi-file downloads that weren't zipped at upload time.
 *
 * The payload is `file[0] || file[1] || …` in metadata order, so it is split
 * sequentially and zipped as it arrives rather than being materialized. The
 * previous implementation held three full copies at once — the ciphertext Blob,
 * the decrypted Blob and the finished zip Blob — which made this the worst of
 * the three download paths for retained bytes, and it POSTed
 * `/download/complete` before the caller had saved anything, so a browser that
 * fell over on the zip Blob burned a download credit and delivered nothing.
 */
async function downloadFileLegacyMultiFile(
    id: string,
    bodyStream: ReadableStream<Uint8Array>,
    contentLength: number,
    metadata: {
        name: string;
        size: number;
        encrypted: boolean;
        zipped?: boolean;
        zipFilename?: string;
        files?: unknown[];
    },
    keychain: Keychain | null,
    files: FileInfo[],
    onProgress?: (loaded: number, total: number) => void,
    onPhase?: (phase: DownloadPhase) => void,
): Promise<{ blob: Blob; filename: string }> {
    const dlLog = (msg: string, data?: Record<string, unknown>) =>
        console.log(`[Download] ${msg}`, data ? data : '');

    onPhase?.('downloading');
    dlLog('Legacy multi-file download (streaming)', { fileCount: files.length });

    const expectedPlaintext = files.reduce((sum, f) => sum + f.size, 0);
    const total =
        contentLength > 0
            ? contentLength
            : metadata.encrypted
              ? calculateEncryptedSize(expectedPlaintext)
              : expectedPlaintext;

    let loaded = 0;
    const progressStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            loaded += chunk.length;
            if (total > 0) {
                onProgress?.(Math.min(loaded, total), total);
            }
            controller.enqueue(chunk);
        },
    });

    // Decryption and zipping both run concurrently with the transfer, so there
    // is no separate 'decrypting' phase on this path either.
    const payloadStream =
        metadata.encrypted && keychain
            ? bodyStream
                  .pipeThrough(progressStream)
                  .pipeThrough(
                      createDecryptionStream(keychain, { eceVersion: readEceVersion(metadata) }),
                  )
            : bodyStream.pipeThrough(progressStream);

    const zipFilename = generateZipFilename(files);
    const { stream: zipStream, estimatedSize } = createZipStreamFromConcatenated(
        payloadStream,
        files,
    );

    // Open the save target before a single byte is pulled: a browser that can
    // only buffer refuses an oversized archive up front instead of OOMing after
    // the whole payload has been transferred.
    const writer = await openSaveTarget(
        {
            filename: zipFilename,
            mimeType: 'application/zip',
            expectedSize: estimatedSize,
        },
        payloadStream,
    );
    dlLog('Save target ready', { strategy: writer.strategy, filename: zipFilename });

    const zipStart = Date.now();
    const zippedSize = await pumpToWriter(zipStream, writer, (e, written) => {
        const message = e instanceof Error ? e.message : String(e);
        captureError(e, {
            operation: 'download.legacy-multifile',
            extra: {
                fileId: id,
                encrypted: metadata.encrypted,
                fileCount: files.length,
                bytesDownloaded: loaded,
                bytesZipped: written,
                saveStrategy: writer.strategy,
                errorMessage: message,
            },
        });
        throw new Error(`Download stream failed: ${message}`);
    });
    dlLog('Legacy zip streamed', { elapsed: Date.now() - zipStart, zipSize: zippedSize });

    // Truncation has to fail before the commit, and nothing else would tear the
    // writer down at this point.
    if (contentLength > 0 && loaded !== contentLength) {
        const err = new Error(
            `Download incomplete: received ${loaded} of ${contentLength} bytes. Please try again.`,
        );
        await writer.abort(err);
        throw err;
    }

    // Commit the archive before burning a download credit.
    onPhase?.('finalizing');
    dlLog('Committing save', { strategy: writer.strategy, filename: zipFilename });
    await writer.close();

    dlLog('Reporting download complete to server...');
    await reportDownloadComplete(id, keychain);

    // Already delivered by the writer — the placeholder stops triggerDownload
    // from saving an empty second copy over it.
    return {
        blob: savedToDiskPlaceholder(),
        filename: zipFilename,
    };
}
