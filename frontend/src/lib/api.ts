/**
 * API utilities for file upload and download
 * Implements resilient direct-to-cloudflare multipart uploads
 */

import { PART_SIZE_TIERS, UPLOAD_LIMITS } from '@bolter/shared';
import {
    arrayToB64,
    b64ToArray,
    calculateEncryptedSize,
    createEncryptionStream,
    ECE_RECORD_SIZE,
    Keychain,
} from './crypto';
import { FileReadError } from './errors';
import { addBreadcrumb, captureError } from './sentry';
import {
    deleteUploadState,
    type PersistedUpload,
    saveUploadState,
    updateCompletedPart,
} from './upload-state';
import {
    createStreamingZip,
    createZipFromFiles,
    createZipFromUploadFiles,
    type FileInfo,
    generateZipFilename,
    sliceConcatenatedData,
} from './zip';

export { FileReadError } from './errors';

// Threshold for using streaming zip (500MB) - below this, buffered zip is fine
const STREAMING_ZIP_THRESHOLD = 500 * 1024 * 1024;

// API base URL - defaults to localhost for development
export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Retry configuration
const MAX_RETRIES = 10;
const RETRY_DELAY_BASE = 2000; // 2 seconds
const MAX_RETRY_DELAY = 60000; // 60 seconds
const STALL_TIMEOUT = 60_000; // Abort upload part if no progress for 60 seconds

// Preflight speed test configuration
const PREFLIGHT_SIZE = 20 * 1024 * 1024; // 20MB test payload
const PREFLIGHT_TIMEOUT = 10_000; // Run for up to 10 seconds

function waitForOnline(): Promise<void> {
    if (navigator.onLine) {
        return Promise.resolve();
    }
    console.log('[Upload] Offline — waiting for connection...');
    return new Promise((resolve) => {
        window.addEventListener('online', () => resolve(), { once: true });
    });
}

/**
 * Measure upload speed with a preflight test.
 * Uploads a 20MB random payload for up to 10 seconds,
 * then returns the measured speed in bytes/second.
 * Returns 0 if the test fails (server will use default part size).
 */
async function measureUploadSpeed(): Promise<number> {
    try {
        const blob = new Blob([crypto.getRandomValues(new Uint8Array(PREFLIGHT_SIZE))]);
        let uploadedBytes = 0;
        const startTime = Date.now();

        return await new Promise<number>((resolve) => {
            const xhr = new XMLHttpRequest();
            const timeout = setTimeout(() => {
                // Time's up — calculate speed from what we managed to send
                xhr.abort();
                const elapsed = (Date.now() - startTime) / 1000;
                resolve(elapsed > 0 ? uploadedBytes / elapsed : 0);
            }, PREFLIGHT_TIMEOUT);

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    uploadedBytes = e.loaded;
                }
            });

            xhr.addEventListener('loadend', () => {
                clearTimeout(timeout);
                const elapsed = (Date.now() - startTime) / 1000;
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(elapsed > 0 ? blob.size / elapsed : 0);
                } else if (xhr.status !== 0) {
                    // Non-zero status = server responded with error
                    console.warn(
                        `[Upload] Speed test failed: HTTP ${xhr.status} ${xhr.statusText}`,
                    );
                    resolve(0);
                } else {
                    // status 0 = aborted by timeout (expected), use tracked bytes
                    resolve(elapsed > 0 ? uploadedBytes / elapsed : 0);
                }
            });

            xhr.addEventListener('error', () => {
                clearTimeout(timeout);
                console.warn(`[Upload] Speed test network error (status=${xhr.status})`);
                resolve(0);
            });

            xhr.open('POST', `${API_BASE_URL}/upload/speedtest`);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.send(blob);
        });
    } catch {
        return 0;
    }
}

function getPreferredPartSize(speed: number): number | undefined {
    if (speed === 0) {
        return undefined;
    }

    for (const tier of PART_SIZE_TIERS) {
        if (speed >= tier.minSpeed) {
            return tier.partSize;
        }
    }
    return PART_SIZE_TIERS[PART_SIZE_TIERS.length - 1].partSize;
}

// Adaptive concurrency based on file size
// With backpressure, memory is bounded to ~(concurrency + 1) * partSize
// e.g., concurrency 3 with 200MB parts = max ~800MB buffered
function getConcurrentUploads(fileSize: number): number {
    const GB = 1024 * 1024 * 1024;
    if (fileSize > 50 * GB) {
        return 2; // > 50GB: conservative
    }
    return 3; // default: 3 concurrent uploads
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
}

export interface UploadOptions {
    files: File[];
    encrypted?: boolean;
    timeLimit?: number;
    downloadLimit?: number;
    onProgress?: (progress: UploadProgress) => void;
    onZipProgress?: (percent: number) => void;
    onSpeedTest?: (phase: 'started' | 'done', speedMbps?: number) => void;
    onError?: (error: UploadError) => void;
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
    uploadId?: string;
    parts?: PartInfo[];
    partSize?: number;
    url: string;
    completeUrl?: string;
}

export class Canceller {
    cancelled = false;
    private xhrs: XMLHttpRequest[] = [];

    cancel() {
        this.cancelled = true;
        this.xhrs.forEach((xhr) => {
            if (xhr.readyState !== XMLHttpRequest.DONE) {
                xhr.abort();
            }
        });
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
    const response = await fetch(`${API_BASE_URL}/config`);
    if (!response.ok) {
        throw new Error('Failed to fetch config');
    }
    return response.json();
}

/**
 * Check if file exists
 */
export async function fileExists(id: string): Promise<boolean> {
    const response = await fetch(`${API_BASE_URL}/exists/${id}`);
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

    console.log('[getMetadata] Response:', {
        encrypted: data.encrypted,
        hasKeychain: !!keychain,
        metadataLength: data.metadata?.length,
        metadataPreview: data.metadata?.substring(0, 50),
    });

    if (data.encrypted !== false && keychain) {
        // Encrypted metadata - decrypt it
        console.log('[getMetadata] Decrypting metadata');
        try {
            metadata = await keychain.decryptMetadata(b64ToArray(data.metadata));
            console.log('[getMetadata] Decryption successful:', metadata);
        } catch (e) {
            console.error('[getMetadata] Decryption failed:', e);
            captureError(e, {
                operation: 'metadata.decrypt',
                extra: { fileId: id, metadataLength: data.metadata?.length },
            });
            throw e;
        }
    } else {
        // Unencrypted metadata - decode from base64
        console.log('[getMetadata] Decoding unencrypted metadata');
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
            console.log('[getMetadata] Decode successful:', metadata);
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
export async function getFileInfo(
    id: string,
    ownerToken: string,
): Promise<{
    dl: number;
    dlimit: number;
    ttl: number;
} | null> {
    try {
        const response = await fetch(`${API_BASE_URL}/info/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner_token: ownerToken }),
        });
        if (!response.ok) {
            return null;
        }
        return response.json();
    } catch {
        return null;
    }
}

/**
 * Get download status (dl, dlimit) - works for unencrypted files without auth
 */
export async function getDownloadStatus(id: string): Promise<{
    dl: number;
    dlimit: number;
} | null> {
    try {
        const response = await fetch(`${API_BASE_URL}/download/url/${id}`);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return { dl: data.dl, dlimit: data.dlimit };
    } catch {
        return null;
    }
}

/**
 * Upload files with resilient multipart support
 * Multi-file uploads are zipped at upload time for efficient downloads
 */
export async function uploadFiles(
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
        onSpeedTest,
        onError,
    } = options;

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
    const useStreamingZip = isMultiFile && totalInputSize >= STREAMING_ZIP_THRESHOLD;

    // For multiple files, create a zip (buffered for small, streaming for large)
    let uploadBlob: Blob | null = null;
    let zipFilename: string | null = null;
    let streamingZipStream: ReadableStream<Uint8Array> | null = null;
    let estimatedZipSize = 0;

    if (isMultiFile) {
        if (useStreamingZip) {
            // Large files: use streaming zip to avoid memory issues
            // Progress will be reported during upload as bytes are processed
            const streamingResult = createStreamingZip(files, (processed, total) => {
                // Report zipping progress as percentage
                onZipProgress?.(Math.round((processed / total) * 100));
            });
            streamingZipStream = streamingResult.stream;
            zipFilename = streamingResult.filename;
            estimatedZipSize = streamingResult.estimatedSize;
        } else {
            // Small files: use buffered zip for compression benefits
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
    // For single file: use file size
    const plainSize = streamingZipStream
        ? estimatedZipSize
        : uploadBlob
          ? uploadBlob.size
          : totalInputSize;
    const totalSize = encrypted ? calculateEncryptedSize(plainSize) : plainSize;

    // Create metadata - keep original file info for display, mark as zipped if applicable
    const metadata: {
        files: { name: string; size: number; type: string }[];
        zipped?: boolean;
        zipFilename?: string;
    } = {
        files: files.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type || 'application/octet-stream',
        })),
    };

    if (isMultiFile && zipFilename) {
        metadata.zipped = true;
        metadata.zipFilename = zipFilename;
    }

    // Create stream based on upload type:
    // - Streaming zip for large multi-file uploads
    // - Blob stream for buffered zip
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

    // Run preflight speed test to determine optimal part size
    onSpeedTest?.('started');
    console.log('[Upload] Running preflight speed test...');
    const measuredSpeed = await measureUploadSpeed();
    const speedMbps = Math.round((measuredSpeed / (1024 * 1024)) * 10) / 10;
    const preferredPartSize = getPreferredPartSize(measuredSpeed);
    console.log(
        `[Upload] Preflight result: ${speedMbps} MB/s → ${preferredPartSize ? `${preferredPartSize / (1024 * 1024)}MB` : 'default'} parts`,
    );
    onSpeedTest?.('done', speedMbps);

    // Request upload URLs
    const uploadResponse = await fetch(`${API_BASE_URL}/upload/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fileSize: totalSize,
            encrypted,
            timeLimit,
            dlimit: downloadLimit,
            preferredPartSize,
        }),
    });

    if (!uploadResponse.ok) {
        throw new Error(`HTTP ${uploadResponse.status}`);
    }

    let uploadInfo: UploadUrlResponse = await uploadResponse.json();

    if (!uploadInfo.useSignedUrl) {
        throw new Error('Pre-signed URLs not available');
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
        const elapsed = (now - lastProgressTime) / 1000;
        const bytesInPeriod = totalLoaded - lastProgressBytes;
        const instantSpeed = elapsed > 0 ? bytesInPeriod / elapsed : 0;

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
    const cleanupStatusPoll = () => {
        clearInterval(statusPollInterval);
        window.removeEventListener('online', onConnectivityChange);
        window.removeEventListener('offline', onConnectivityChange);
    };

    let uploadResult: { actualSize: number; parts?: { PartNumber: number; ETag: string }[] };

    try {
        if (uploadInfo.multipart && uploadInfo.parts) {
            // Only persist resumability state for single-file uploads.
            // Multi-file uploads create a streaming zip that can't be
            // reconstructed from the original files on resume.
            const canResume = !isMultiFile;
            if (canResume) {
                // Calculate plaintext bytes per encrypted part
                // Each ECE record: plaintext ECE_RECORD_SIZE → encrypted ECE_RECORD_SIZE + 17 (tag + delimiter)
                const encryptedRecordSize = ECE_RECORD_SIZE + 17;
                const plaintextPartSize = encrypted
                    ? Math.floor((uploadInfo.partSize || 0) / encryptedRecordSize) * ECE_RECORD_SIZE
                    : uploadInfo.partSize || 0;
                const persistState: PersistedUpload = {
                    fileId: uploadInfo.id,
                    uploadId: uploadInfo.uploadId || '',
                    ownerToken: uploadInfo.owner,
                    fileName: files[0].name,
                    fileSize: files[0].size,
                    fileLastModified: files[0].lastModified,
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

            // Multipart upload
            const multipartResult = await uploadMultipartStream(
                stream,
                uploadInfo,
                updateProgress,
                canceller,
                onError,
                totalSize,
                () => {
                    totalRetryCount++;
                    // Trigger a progress update so the UI reflects the new retry count.
                    // Re-emit part 1's current tracked bytes (or 0 if not started yet).
                    const part1Bytes = partProgress[1] ?? 0;
                    updateProgress(1, part1Bytes);
                },
                canResume ? uploadInfo.id : undefined,
            );

            // Handle fallback: stream produced too little data for multipart
            if ('fallbackBlob' in multipartResult) {
                console.log(
                    `[Upload] Falling back to single-part upload (${(multipartResult.fallbackBlob.size / 1024).toFixed(1)}KB)`,
                );

                // Abort the multipart upload
                if (uploadInfo.uploadId) {
                    await abortMultipartUpload(uploadInfo.id, uploadInfo.uploadId);
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

                // Use the new file ID and owner from the fallback response
                uploadInfo = fallbackInfo;

                uploadResult = await uploadSinglePart(
                    multipartResult.fallbackBlob,
                    fallbackInfo.url,
                    (loaded) => updateProgress(1, loaded),
                    canceller,
                );
            } else {
                uploadResult = multipartResult;
            }
        } else {
            // Single part upload
            const blob = await new Response(stream).blob();
            uploadResult = await uploadSinglePart(
                blob,
                uploadInfo.url,
                (loaded) => updateProgress(1, loaded),
                canceller,
            );
        }

        if (canceller.cancelled) {
            if (uploadInfo.multipart && uploadInfo.uploadId) {
                await abortMultipartUpload(uploadInfo.id, uploadInfo.uploadId);
                deleteUploadState(uploadInfo.id).catch(() => {
                    // Intentionally ignored — best-effort cleanup
                });
            }
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

        const _completeInfo = await completeResponse.json();

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
        };
    } finally {
        cleanupStatusPoll();
    }
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

    // Use plaintext part size for file offset (encrypted part size includes ECE overhead)
    const plaintextPartSize = state.plaintextPartSize || state.partSize;
    const skipBytes = contiguousCount * plaintextPartSize;

    // Request new pre-signed URLs for remaining parts
    const resumeResponse = await fetch(`${API_BASE_URL}/upload/multipart/${state.fileId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            uploadId: state.uploadId,
            completedPartNumbers: trulyCompletedParts.map((p) => p.PartNumber),
        }),
    });

    if (!resumeResponse.ok) {
        // Upload expired or invalid — clean up and throw
        await deleteUploadState(state.fileId);
        throw new Error('Upload session expired. Please start a new upload.');
    }

    const resumeInfo: {
        parts: Array<{ partNumber: number; url: string; minSize: number; maxSize: number }>;
        partSize: number;
        numParts: number;
    } = await resumeResponse.json();

    // Create a stream from the file, skipping already-uploaded data
    const remainingBlob = file.slice(skipBytes);
    let stream: ReadableStream<Uint8Array> = remainingBlob.stream();

    // If encrypted, wrap with encryption stream starting at the correct counter
    if (state.encrypted && keychain) {
        // Each plaintext part contains ceil(plaintextPartSize / ECE_RECORD_SIZE) records
        const recordsPerPart = Math.ceil(plaintextPartSize / ECE_RECORD_SIZE);
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

    // Account for already-completed data in progress
    // Use encrypted part size for progress since that's what's actually uploaded
    const alreadyUploaded = contiguousCount * state.partSize;
    const totalSize = state.totalParts * state.partSize;

    const updateProgress = (partNum: number, loaded: number) => {
        partProgress[partNum] = loaded;
        const partLoaded = Object.values(partProgress).reduce((sum, p) => sum + p, 0);
        const totalLoaded = alreadyUploaded + partLoaded;

        const now = Date.now();
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
    );

    if ('fallbackBlob' in multipartResult) {
        throw new Error('Resume failed: unexpected fallback');
    }

    if (cancel.cancelled) {
        throw new Error('Upload cancelled');
    }

    // Combine completed parts (contiguous prefix + newly uploaded)
    const allParts = [...trulyCompletedParts, ...(multipartResult.parts || [])];

    // Complete the upload
    let metadataString: string;
    if (state.encrypted && keychain) {
        const metadata = {
            files: [
                { name: file.name, size: file.size, type: file.type || 'application/octet-stream' },
            ],
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
            actualSize: totalSize,
            parts: allParts,
        }),
    });

    if (!completeResponse.ok) {
        throw new Error(`Failed to complete resumed upload: ${await completeResponse.text()}`);
    }

    await completeResponse.json();

    // Clean up persisted state
    await deleteUploadState(state.fileId);

    const downloadUrl = `${window.location.origin}/download/${state.fileId}`;

    return {
        id: state.fileId,
        url: downloadUrl,
        ownerToken: state.ownerToken,
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
                    throw new FileReadError(currentFile?.name, e);
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
 * Upload a single part
 */
function uploadSinglePart(
    blob: Blob,
    url: string,
    onProgress: (loaded: number) => void,
    canceller: Canceller,
): Promise<{ actualSize: number }> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        canceller.addXhr(xhr);

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                onProgress(e.loaded);
            }
        });

        xhr.addEventListener('loadend', () => {
            canceller.removeXhr(xhr);
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve({ actualSize: blob.size });
            } else {
                const err = new Error(`HTTP ${xhr.status}`);
                captureError(err, {
                    operation: 'upload.single',
                    extra: {
                        httpStatus: xhr.status,
                        statusText: xhr.statusText,
                        blobSize: blob.size,
                        responsePreview: xhr.responseText?.substring(0, 200),
                    },
                });
                reject(err);
            }
        });

        xhr.addEventListener('error', () => {
            canceller.removeXhr(xhr);
            const err = new Error('Network error');
            captureError(err, {
                operation: 'upload.single.network',
                extra: { blobSize: blob.size },
            });
            reject(err);
        });

        xhr.open('PUT', url);
        xhr.send(blob);
    });
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
): Promise<MultipartStreamResult> {
    const { parts, partSize } = uploadInfo;
    if (!parts || !partSize) {
        throw new Error('Invalid upload info');
    }

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
    let resolveAllDone: () => void;
    const allDonePromise = new Promise<void>((resolve) => {
        resolveAllDone = resolve;
    });

    // Upload a single part and manage concurrency
    const doUploadPart = async (
        partBlob: Blob,
        partNum: number,
        partUrl: string,
    ): Promise<void> => {
        try {
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
            uploadedPartSizes[partNum] = partBlob.size;
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
        } finally {
            activeUploads--;
            totalPartsFinished++;
            console.log(
                `[Upload] Progress: ${totalPartsFinished}/${totalPartsQueued} parts finished, ${activeUploads} active`,
            );

            // Check if all done
            if (totalPartsFinished === totalPartsQueued) {
                resolveAllDone();
            }

            // Start next queued upload if any
            processQueue();
        }
    };

    // Queue of pending uploads (not yet started due to concurrency limit)
    const pendingQueue: Array<{ blob: Blob; partNum: number; url: string }> = [];

    // Process the queue, starting uploads up to maxConcurrent
    const processQueue = (): void => {
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
            // Validate: all non-trailing parts must be exactly partSize for R2 compliance
            if (bufferedItem.blob.size !== partSize) {
                const diagnostic = {
                    partNumber: bufferedItem.partNum,
                    actualSize: bufferedItem.blob.size,
                    expectedSize: partSize,
                    uploadId: uploadInfo.uploadId,
                    totalParts: parts.length,
                    totalFileSize,
                };
                console.error(
                    `[Upload] Non-trailing part ${bufferedItem.partNum} size mismatch: ${bufferedItem.blob.size} !== ${partSize}`,
                    diagnostic,
                );
                captureError(
                    new Error(
                        `Non-trailing part size mismatch: part ${bufferedItem.partNum} is ${bufferedItem.blob.size} bytes, expected ${partSize}`,
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

    let currentPartIndex = 0;
    let currentPartData: Uint8Array[] = [];
    let currentPartSize = 0;
    let leftoverData: Uint8Array | null = null;

    try {
        let streamDone = false;

        while (currentPartIndex < parts.length) {
            const part = parts[currentPartIndex];

            // Add leftover data from previous part
            if (leftoverData) {
                currentPartData.push(leftoverData);
                currentPartSize += leftoverData.length;
                leftoverData = null;
            }

            // Read data for this part
            // For the last allocated part, drain ALL remaining stream data (trailing part absorbs excess)
            const isLastAllocatedPart = currentPartIndex >= parts.length - 1;
            while (!streamDone && (isLastAllocatedPart || currentPartSize < partSize)) {
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

                const wouldExceed = currentPartSize + value.length > partSize;

                if (wouldExceed && !isLastAllocatedPart) {
                    const remainingSpace = partSize - currentPartSize;
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

            // Buffer part if we have data
            if (currentPartData.length > 0) {
                const partBlob = new Blob(currentPartData);
                currentPartData = [];
                currentPartSize = 0;

                queueOrBuffer(partBlob, part.partNumber, part.url);

                // Backpressure: wait if we have too many parts buffered
                const maxBuffered = maxConcurrent + 1;
                if (pendingQueue.length + activeUploads >= maxBuffered) {
                    await new Promise<void>((resolve) => {
                        const checkRoom = setInterval(() => {
                            if (pendingQueue.length + activeUploads < maxBuffered) {
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
        if (bufferedItem) {
            // Check if we only have 1 part total and it's too small for multipart
            const noPriorParts = totalPartsQueued === 0 && activeUploads === 0;

            if (noPriorParts && bufferedItem.blob.size < MIN_PART) {
                // Entire stream output is a single tiny blob — fallback to single-part upload
                console.log(
                    `[Upload] Stream produced only ${(bufferedItem.blob.size / 1024).toFixed(1)}KB — falling back to single-part upload`,
                );
                return { fallbackBlob: bufferedItem.blob };
            }

            // Check if final part is too small and we can merge it with a pending part
            if (bufferedItem.blob.size < MIN_PART && pendingQueue.length > 0) {
                // Merge with the last pending part
                const lastPending = pendingQueue[pendingQueue.length - 1];
                totalUploadedSize += bufferedItem.blob.size;
                const mergedBlob = new Blob([lastPending.blob, bufferedItem.blob]);
                console.log(
                    `[Upload] Merging small final part (${(bufferedItem.blob.size / 1024).toFixed(1)}KB) into part ${lastPending.partNum} (${(lastPending.blob.size / (1024 * 1024)).toFixed(1)}MB → ${(mergedBlob.size / (1024 * 1024)).toFixed(1)}MB)`,
                );
                lastPending.blob = mergedBlob;
                // Don't queue the tiny buffered item separately
            } else {
                // Final part is large enough, or no pending parts to merge with — queue it normally
                totalUploadedSize += bufferedItem.blob.size;
                totalPartsQueued++;
                pendingQueue.push(bufferedItem);
            }

            bufferedItem = null;
            processQueue();
        }

        // Wait for all uploads to complete
        if (totalPartsQueued > 0 && totalPartsFinished < totalPartsQueued) {
            console.log(
                `[Upload] Waiting for ${totalPartsQueued - totalPartsFinished} remaining uploads...`,
            );
            await allDonePromise;
        }

        // Check for failures
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

        console.log(`[Upload] All ${completedParts.length} parts completed successfully`);

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
                captureError(
                    new Error(
                        `Non-trailing part size inconsistency: expected ${expectedNonTrailingSize}, found ${inconsistentParts.map((p) => `part ${p.partNumber}=${p.size}`).join(', ')}`,
                    ),
                    {
                        operation: 'upload.part-size-consistency',
                        extra: diagnostic,
                    },
                );
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
): Promise<{ PartNumber: number; ETag: string }> {
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
            await waitForOnline();
            const delay = Math.min(
                RETRY_DELAY_BASE * 2 ** retryCount + Math.random() * 1000,
                MAX_RETRY_DELAY,
            );

            console.log(`[Upload] Retrying part ${partNumber} in ${(delay / 1000).toFixed(1)}s...`);

            onRetry?.();

            await new Promise((resolve) => setTimeout(resolve, delay));

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
): Promise<{ PartNumber: number; ETag: string }> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        canceller.addXhr(xhr);

        let stallTimer: ReturnType<typeof setTimeout>;
        let stalledAbort = false;
        const resetStallTimer = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                stalledAbort = true;
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
                const etag = xhr.getResponseHeader('ETag') || '';
                resolve({ PartNumber: partNumber, ETag: etag });
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
 * Check if an error is retryable
 * Includes browser abort errors (NS_BINDING_ABORTED in Firefox) which often happen
 * due to memory pressure or connection limits
 */
function isRetryableError(error: Error): boolean {
    const msg = (error.message || '').toLowerCase();
    return (
        msg.includes('network error') ||
        msg.includes('network') ||
        msg.includes('timeout') ||
        msg.includes('abort') ||
        msg.includes('stalled') ||
        msg.includes('failed to fetch') ||
        /http 5\d\d/.test(msg) ||
        msg.includes('http 429') ||
        msg.includes('http 408') ||
        msg.includes('http 0') // Often indicates network failure
    );
}

/**
 * Abort a multipart upload
 */
async function abortMultipartUpload(id: string, uploadId: string): Promise<void> {
    try {
        await fetch(`${API_BASE_URL}/upload/abort/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId }),
        });
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
 * Download a file
 */
export async function downloadFile(
    id: string,
    keychain: Keychain | null,
    onProgress?: (loaded: number, total: number) => void,
): Promise<{ blob: Blob; filename: string }> {
    addBreadcrumb('downloadFile called', {
        category: 'download',
        data: { fileId: id, encrypted: !!keychain },
    });

    // Get metadata first
    const metadata = await getMetadata(id, keychain || undefined);

    // Get download URL
    const headers: Record<string, string> = {};
    if (keychain) {
        headers.Authorization = await keychain.authHeader();
    }

    let urlResponse = await fetch(`${API_BASE_URL}/download/url/${id}`, { headers });

    // Handle 401 challenge-response: extract nonce and retry
    if (urlResponse.status === 401 && keychain) {
        const authHeader = urlResponse.headers.get('WWW-Authenticate');
        if (authHeader) {
            const nonce = authHeader.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
                headers.Authorization = await keychain.authHeader();
                urlResponse = await fetch(`${API_BASE_URL}/download/url/${id}`, { headers });
            }
        }
    }

    // Extract nonce for future requests
    if (keychain) {
        const authHeader = urlResponse.headers.get('WWW-Authenticate');
        if (authHeader) {
            const nonce = authHeader.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
            }
        }
    }

    if (!urlResponse.ok) {
        const err = new Error(`HTTP ${urlResponse.status}`);
        captureError(err, {
            operation: 'download.url-fetch',
            extra: { fileId: id, httpStatus: urlResponse.status, encrypted: !!keychain },
        });
        throw err;
    }

    const urlData = await urlResponse.json();

    // Download from signed URL or stream
    const downloadUrl = urlData.useSignedUrl ? urlData.url : `${API_BASE_URL}/download/${id}`;
    const downloadHeaders: Record<string, string> = {};

    if (!urlData.useSignedUrl && keychain) {
        downloadHeaders.Authorization = await keychain.authHeader();
    }

    let response = await fetch(downloadUrl, { headers: downloadHeaders });

    // Handle 401 challenge-response for direct downloads
    if (response.status === 401 && keychain && !urlData.useSignedUrl) {
        const authHeader = response.headers.get('WWW-Authenticate');
        if (authHeader) {
            const nonce = authHeader.split(' ')[1];
            if (nonce) {
                keychain.nonce = nonce;
                downloadHeaders.Authorization = await keychain.authHeader();
                response = await fetch(downloadUrl, { headers: downloadHeaders });
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
    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
    const reader = response.body?.getReader();

    if (!reader) {
        throw new Error('No response body');
    }

    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        chunks.push(value);
        loaded += value.length;
        onProgress?.(loaded, contentLength || metadata.size || loaded);
    }

    // Combine chunks
    const data = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
    }

    // Decrypt if needed
    let decryptedData: Uint8Array;
    if (metadata.encrypted && keychain) {
        const { createDecryptionStream } = await import('./crypto');
        const decryptStream = createDecryptionStream(keychain);
        const decryptedResponse = new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(data);
                    controller.close();
                },
            }).pipeThrough(decryptStream),
        );
        decryptedData = new Uint8Array(await decryptedResponse.arrayBuffer());
    } else {
        decryptedData = data;
    }

    // Report download complete
    await fetch(`${API_BASE_URL}/download/complete/${id}`, {
        method: 'POST',
        headers: keychain ? { Authorization: await keychain.authHeader() } : {},
    }).catch((e) => {
        console.warn('Failed to report download complete:', e);
        captureError(e, {
            operation: 'download.complete',
            extra: { fileId: id },
            level: 'warning',
        });
    });

    // Handle multiple files
    const files = metadata.files as FileInfo[] | undefined;

    // If file was zipped at upload time, return the zip directly
    if (metadata.zipped) {
        return {
            blob: new Blob([decryptedData], { type: 'application/zip' }),
            filename: metadata.zipFilename || generateZipFilename(files || []),
        };
    }

    // Legacy: multiple files uploaded before zip-at-upload-time feature
    // Slice data and create zip on the fly (may fail for very large files)
    if (files && files.length > 1) {
        const fileSlices = sliceConcatenatedData(decryptedData, files);
        const zipBlob = await createZipFromFiles(fileSlices);
        return {
            blob: zipBlob,
            filename: generateZipFilename(files),
        };
    }

    // Single file: return as-is
    return {
        blob: new Blob([decryptedData]),
        filename: metadata.name || 'download',
    };
}
