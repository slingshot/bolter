/**
 * Streaming download engine
 *
 * Fetches a file from the Bolter backend, optionally decrypts it client-side,
 * and writes it to disk with real-time progress reporting.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileMetadata } from './api';
import { checkExists, getDownloadUrl, getMetadata, reportDownloadComplete } from './api';
import { resolveServer } from './config-store';
import { createDecryptionStream, Keychain } from './crypto';
import { parseBolterUrl } from './url';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DownloadProgress {
    /** Bytes received so far */
    loaded: number;
    /** Total bytes expected (from Content-Length or metadata) */
    total: number;
    /** 0-100 completion percentage */
    percentage: number;
    /** Smoothed transfer speed in bytes/second */
    speed: number;
    /** Estimated seconds remaining */
    eta: number;
}

export interface DownloadOptions {
    /** Bolter URL or bare file ID */
    url: string;
    /** Output directory or file path (default: cwd) */
    outputPath?: string;
    /** Override server URL */
    serverOverride?: string;
    /** Progress callback */
    onProgress?: (progress: DownloadProgress) => void;
    /** JSON output mode — suppresses human-readable output */
    json?: boolean;
}

export interface DownloadResult {
    /** Final path the file was written to */
    filePath: string;
    /** Original file name from metadata */
    fileName: string;
    /** Total file size in bytes */
    fileSize: number;
    /** Whether the file was encrypted */
    encrypted: boolean;
    /** Wall-clock download duration in seconds */
    duration: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimum interval (ms) between progress callbacks */
const PROGRESS_INTERVAL_MS = 250;

/** Exponential smoothing factor for speed calculation (weight of old value) */
const SPEED_SMOOTH_FACTOR = 0.7;

/**
 * Determine whether `p` is an existing directory.
 */
async function isDirectory(p: string): Promise<boolean> {
    try {
        const s = await stat(p);
        return s.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Build a TransformStream that counts bytes flowing through it and reports
 * progress via a callback.  The stream itself is a pass-through — chunks are
 * forwarded unchanged.
 */
function createProgressStream(
    total: number,
    onProgress: (progress: DownloadProgress) => void,
): TransformStream<Uint8Array, Uint8Array> {
    let loaded = 0;
    let smoothedSpeed = 0;
    let lastReportTime = 0;
    let lastReportBytes = 0;
    const startTime = Date.now();

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            loaded += chunk.byteLength;
            controller.enqueue(chunk);

            const now = Date.now();
            const elapsed = now - lastReportTime;

            // Throttle callbacks to avoid overwhelming the terminal
            if (elapsed < PROGRESS_INTERVAL_MS && loaded < total) {
                return;
            }

            // Instantaneous speed over the last reporting window
            const windowBytes = loaded - lastReportBytes;
            const instantSpeed = elapsed > 0 ? (windowBytes / elapsed) * 1000 : 0;

            // Exponentially smoothed speed
            smoothedSpeed =
                smoothedSpeed === 0
                    ? instantSpeed
                    : SPEED_SMOOTH_FACTOR * smoothedSpeed +
                      (1 - SPEED_SMOOTH_FACTOR) * instantSpeed;

            const remaining = total - loaded;
            const eta = smoothedSpeed > 0 ? remaining / smoothedSpeed : 0;
            const percentage =
                total > 0 ? Math.min(100, Math.round((loaded / total) * 1000) / 10) : 0;

            onProgress({ loaded, total, percentage, speed: smoothedSpeed, eta });

            lastReportTime = now;
            lastReportBytes = loaded;
        },

        flush() {
            // Ensure a final 100 % report
            const totalElapsed = (Date.now() - startTime) / 1000;
            const avgSpeed = totalElapsed > 0 ? loaded / totalElapsed : 0;

            onProgress({
                loaded,
                total: loaded, // use actual loaded as truth
                percentage: 100,
                speed: avgSpeed,
                eta: 0,
            });
        },
    });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
    const startTime = Date.now();

    // 1. Parse URL → fileId + optional secretKey
    const { fileId, secretKey } = parseBolterUrl(options.url);
    if (!fileId) {
        throw new Error('Could not extract a file ID from the provided URL.');
    }

    // 2. Resolve server URL
    const server = await resolveServer(options.serverOverride);

    // 3. Check existence
    const exists = await checkExists(server, fileId);
    if (!exists) {
        throw new Error(`File not found: ${fileId}`);
    }

    // 4. Build keychain if a secret key is available
    const keychain = secretKey ? new Keychain(secretKey) : undefined;

    // 5. Fetch metadata (handles challenge-response auth internally)
    const metadata: FileMetadata = await getMetadata(server, fileId, keychain);

    // 6. Determine output path
    const fileName = metadata.name || 'download';
    let outputFilePath: string;

    if (options.outputPath) {
        if (await isDirectory(options.outputPath)) {
            outputFilePath = join(options.outputPath, fileName);
        } else {
            outputFilePath = options.outputPath;
        }
    } else {
        outputFilePath = join(process.cwd(), fileName);
    }

    // 7. Get download URL
    const downloadInfo = await getDownloadUrl(server, fileId, keychain);
    if (!downloadInfo.url) {
        throw new Error('Server did not provide a download URL');
    }
    const downloadUrl: string = downloadInfo.url;

    // 8. Fetch the file
    const response = await fetch(downloadUrl);
    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
        throw new Error('Download failed: response has no body');
    }

    // Total size from Content-Length, falling back to metadata
    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : metadata.size || 0;

    const encrypted = !!(keychain && metadata.encrypted);

    // 9. Build the streaming pipeline
    //    source → progress tracker → (optional) decryption → disk
    let stream: ReadableStream<Uint8Array> = response.body;

    // Progress tracking
    if (options.onProgress && total > 0) {
        const progressStream = createProgressStream(total, options.onProgress);
        stream = stream.pipeThrough(progressStream);
    }

    // Decryption (when the file is encrypted and we hold a key)
    if (encrypted && keychain) {
        const decryptStream = createDecryptionStream(keychain);
        stream = stream.pipeThrough(decryptStream);
    }

    // 10. Write to disk using streaming writes
    const writer = Bun.file(outputFilePath).writer();
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            writer.write(value);
        }
    } finally {
        await writer.end();
    }

    // 11. Report download completion to the server
    try {
        await reportDownloadComplete(server, fileId, keychain);
    } catch {
        // Non-fatal — the file is already saved locally
    }

    // 12. Compute final result
    const duration = (Date.now() - startTime) / 1000;
    const fileStat = await stat(outputFilePath);

    return {
        filePath: outputFilePath,
        fileName,
        fileSize: fileStat.size,
        encrypted,
        duration,
    };
}
