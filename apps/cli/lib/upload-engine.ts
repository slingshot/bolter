/**
 * Multipart upload orchestration engine with streaming encryption,
 * concurrency control, adaptive part sizing, and stall detection.
 */

import { PART_SIZE_TIERS, UPLOAD_LIMITS } from '@bolter/shared';
import {
    resumeUpload as apiResumeUpload,
    cleanupSpeedTest,
    completeUpload,
    requestUploadUrl,
    runSpeedTest,
    uploadPart,
} from './api';
import {
    arrayToB64,
    calculateEncryptedSize,
    createEncryptionStream,
    ECE_RECORD_SIZE,
    Keychain,
} from './crypto';
import type { PersistedUpload } from './upload-state';
import * as uploadState from './upload-state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadProgress {
    loaded: number;
    total: number;
    percentage: number;
    speed: number; // bytes/second
    eta: number; // seconds remaining
    phase: 'speedtest' | 'zipping' | 'uploading' | 'completing';
}

export interface UploadOptions {
    filePath: string; // Path to file (or temp zip)
    fileName: string; // Display name
    fileSize: number; // Raw file size
    fileMtime: number; // For resume matching
    encrypted: boolean;
    keychain: Keychain;
    timeLimit: number; // seconds
    downloadLimit: number;
    server: string;
    onProgress?: (progress: UploadProgress) => void;
    noResume?: boolean; // skip saving resume state
}

export interface UploadResult {
    id: string;
    ownerToken: string;
    duration: number; // seconds
    size: number; // bytes uploaded
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concurrency limit based on file size. */
function getAdaptiveConcurrency(fileSize: number): number {
    const FIFTY_GB = 50 * 1000 * 1000 * 1000;
    return fileSize > FIFTY_GB ? 3 : 5;
}

/**
 * Pick the best part size tier for the measured upload speed.
 * PART_SIZE_TIERS is sorted descending by minSpeed, so the first match wins.
 */
function getPreferredPartSize(speed: number): number | undefined {
    for (const tier of PART_SIZE_TIERS) {
        if (speed >= tier.minSpeed) {
            return tier.partSize;
        }
    }
    return undefined;
}

/**
 * Run a speed test against the server and return measured throughput (bytes/s).
 *
 * Uploads 5 concurrent 100MB buffers for up to 10 seconds, then aborts any
 * remaining transfers and cleans up the test objects.
 */
async function measureUploadSpeed(server: string): Promise<number> {
    const testResult = await runSpeedTest(server);
    const CHUNK_SIZE = 100 * 1000 * 1000; // 100MB
    const buffer = new Uint8Array(CHUNK_SIZE);
    const MAX_DURATION_MS = 10_000;

    const start = performance.now();
    let totalBytes = 0;
    const controller = new AbortController();

    // Set a hard timeout
    const timeout = setTimeout(() => controller.abort(), MAX_DURATION_MS);

    try {
        const uploads = testResult.parts.map(async (part) => {
            if (controller.signal.aborted) {
                return;
            }
            try {
                await uploadPart(part.url, buffer, CHUNK_SIZE, controller.signal);
                totalBytes += CHUNK_SIZE;
            } catch {
                // Aborted or failed — that's expected when the timer fires
            }
        });

        await Promise.allSettled(uploads);
    } finally {
        clearTimeout(timeout);
        // Clean up test objects
        try {
            await cleanupSpeedTest(server, testResult.testId, testResult.uploadId);
        } catch {
            // Best-effort cleanup
        }
    }

    const elapsedMs = performance.now() - start;
    const elapsedSec = elapsedMs / 1000;

    // Avoid division by zero
    return elapsedSec > 0 ? totalBytes / elapsedSec : 0;
}

/**
 * Simple semaphore for limiting concurrency.
 */
class Semaphore {
    private queue: (() => void)[] = [];
    private running = 0;

    constructor(private max: number) {}

    async acquire(): Promise<void> {
        if (this.running < this.max) {
            this.running++;
            return;
        }
        await new Promise<void>((resolve) => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) {
            this.running++;
            next();
        }
    }
}

/**
 * Split a ReadableStream into fixed-size chunks, collecting each into
 * a Uint8Array. Yields { index, data } for each part.
 *
 * Uses pre-allocated buffers with offset-based filling to avoid O(n²)
 * memory copies. Only one .slice() copy happens per complete part.
 *
 * The final chunk may be smaller than `partSize`. If the final chunk is
 * smaller than `minPartSize`, it is merged into the previous chunk.
 */
async function* splitStream(
    stream: ReadableStream<Uint8Array>,
    partSize: number,
    minPartSize: number,
): AsyncGenerator<{ index: number; data: Uint8Array }> {
    const reader = stream.getReader();
    let index = 0;
    let buffer = new Uint8Array(partSize);
    let offset = 0;
    let previousChunk: { index: number; data: Uint8Array } | null = null;

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (value) {
                // Fill the pre-allocated buffer, yielding complete parts as we go
                let valueOffset = 0;
                while (valueOffset < value.length) {
                    const space = partSize - offset;
                    const toCopy = Math.min(space, value.length - valueOffset);
                    buffer.set(value.subarray(valueOffset, valueOffset + toCopy), offset);
                    offset += toCopy;
                    valueOffset += toCopy;

                    if (offset >= partSize) {
                        // Buffer full — one copy to create the immutable part
                        const chunk = buffer.slice(0, offset);
                        if (previousChunk) {
                            yield previousChunk;
                        }
                        previousChunk = { index, data: chunk };
                        index++;
                        buffer = new Uint8Array(partSize);
                        offset = 0;
                    }
                }
            }

            if (done) {
                break;
            }
        }

        // Handle remaining data
        if (offset > 0) {
            const remaining = buffer.slice(0, offset);
            if (remaining.length < minPartSize && previousChunk) {
                // Merge small trailing part with the previous chunk
                const merged = new Uint8Array(previousChunk.data.length + remaining.length);
                merged.set(previousChunk.data);
                merged.set(remaining, previousChunk.data.length);
                yield { index: previousChunk.index, data: merged };
            } else {
                if (previousChunk) {
                    yield previousChunk;
                }
                yield { index, data: remaining };
            }
        } else if (previousChunk) {
            yield previousChunk;
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Build file metadata in the format the frontend expects:
 * { files: [{ name, size, type }], zipped?, zipFilename? }
 */
function buildFileMetadata(
    fileName: string,
    fileSize: number,
    options?: { zipped?: boolean; zipFilename?: string },
): object {
    const meta: {
        files: { name: string; size: number; type: string }[];
        zipped?: boolean;
        zipFilename?: string;
    } = {
        files: [{ name: fileName, size: fileSize, type: 'application/octet-stream' }],
    };
    if (options?.zipped) {
        meta.zipped = true;
        meta.zipFilename = options.zipFilename;
    }
    return meta;
}

/**
 * Build metadata string for the completeUpload call.
 * Uses the same encoding as the frontend:
 * - Encrypted: arrayToB64(encryptMetadata(metadata))
 * - Unencrypted: btoa(unescape(encodeURIComponent(JSON.stringify(metadata))))
 */
async function buildMetadataString(
    encrypted: boolean,
    keychain: Keychain,
    metadata: object,
): Promise<string> {
    if (encrypted) {
        return arrayToB64(await keychain.encryptMetadata(metadata));
    }
    // Match frontend encoding: UTF-8 safe base64
    return btoa(unescape(encodeURIComponent(JSON.stringify(metadata))));
}

// ---------------------------------------------------------------------------
// Main upload function
// ---------------------------------------------------------------------------

/**
 * Execute a full file upload — handles speed testing, adaptive part sizing,
 * single-part and multipart uploads, encryption, stall detection, and
 * resume-state persistence.
 */
export async function executeUpload(options: UploadOptions): Promise<UploadResult> {
    const {
        filePath,
        fileName,
        fileSize,
        fileMtime,
        encrypted,
        keychain,
        timeLimit,
        downloadLimit,
        server,
        onProgress,
        noResume,
    } = options;

    const startTime = performance.now();

    // 1. Calculate the final (possibly encrypted) size
    const totalSize = encrypted ? calculateEncryptedSize(fileSize) : fileSize;

    // 2. Speed test + adaptive part sizing for large files
    let preferredPartSize: number | undefined;
    if (fileSize > UPLOAD_LIMITS.MULTIPART_THRESHOLD) {
        onProgress?.({
            loaded: 0,
            total: totalSize,
            percentage: 0,
            speed: 0,
            eta: 0,
            phase: 'speedtest',
        });

        const speed = await measureUploadSpeed(server);
        preferredPartSize = getPreferredPartSize(speed);
    }

    // 3. Request upload URLs from the backend
    const uploadInfo = await requestUploadUrl(server, {
        fileSize: totalSize,
        encrypted,
        timeLimit,
        dlimit: downloadLimit,
        preferredPartSize,
    });

    // Progress tracking state
    let loaded = 0;
    const progressStart = performance.now();

    const reportProgress = () => {
        if (!onProgress) {
            return;
        }
        const elapsed = (performance.now() - progressStart) / 1000;
        const speed = elapsed > 0 ? loaded / elapsed : 0;
        const remaining = totalSize - loaded;
        const eta = speed > 0 ? remaining / speed : 0;
        onProgress({
            loaded,
            total: totalSize,
            percentage: totalSize > 0 ? Math.round((loaded / totalSize) * 100) : 0,
            speed,
            eta,
            phase: 'uploading',
        });
    };

    // 4. Single-part upload (non-multipart)
    if (!uploadInfo.multipart) {
        let stream: ReadableStream<Uint8Array> = Bun.file(filePath).stream();
        if (encrypted) {
            stream = stream.pipeThrough(createEncryptionStream(keychain));
        }

        // Collect the stream into a single Uint8Array for the PUT
        const chunks: Uint8Array[] = [];
        const reader = stream.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value) {
                chunks.push(value);
                loaded += value.length;
                reportProgress();
            }
        }
        const body = concatUint8Arrays(chunks);

        await uploadPart(uploadInfo.url, body, body.length);
        loaded = totalSize;
        reportProgress();

        // Complete
        onProgress?.({
            loaded: totalSize,
            total: totalSize,
            percentage: 100,
            speed: 0,
            eta: 0,
            phase: 'completing',
        });

        const metadata = buildFileMetadata(fileName, fileSize);
        const metadataStr = await buildMetadataString(encrypted, keychain, metadata);
        const authKey = encrypted ? await keychain.authKeyB64() : undefined;

        await completeUpload(server, {
            id: uploadInfo.id,
            metadata: metadataStr,
            authKey,
            actualSize: totalSize,
        });

        const duration = (performance.now() - startTime) / 1000;
        return {
            id: uploadInfo.id,
            ownerToken: uploadInfo.owner,
            duration,
            size: totalSize,
        };
    }

    // 5. Multipart upload
    const parts = uploadInfo.parts ?? [];
    const partSize = uploadInfo.partSize ?? UPLOAD_LIMITS.DEFAULT_PART_SIZE;
    const plaintextPartSize = encrypted
        ? Math.floor(partSize / (ECE_RECORD_SIZE + 17)) * ECE_RECORD_SIZE
        : partSize;
    const totalParts = parts.length;
    const concurrency = getAdaptiveConcurrency(fileSize);

    // Save resume state
    if (!noResume) {
        await uploadState.save({
            fileId: uploadInfo.id,
            uploadId: uploadInfo.uploadId ?? '',
            ownerToken: uploadInfo.owner,
            fileName,
            fileSize,
            fileMtime,
            encrypted,
            partSize,
            plaintextPartSize,
            completedParts: [],
            totalParts,
            secretKeyB64: encrypted ? keychain.secretKeyB64 : undefined,
            timeLimit,
            downloadLimit,
            createdAt: Date.now(),
        });
    }

    // Build file stream with optional encryption
    let stream: ReadableStream<Uint8Array> = Bun.file(filePath).stream();
    if (encrypted) {
        stream = stream.pipeThrough(createEncryptionStream(keychain));
    }

    // Upload parts with concurrency control and stall detection
    const completedParts: { PartNumber: number; ETag: string }[] = [];
    const semaphore = new Semaphore(concurrency);
    const STALL_TIMEOUT_MS = 60_000;
    const MAX_RETRIES = 10;
    const partUrlMap = new Map(parts.map((p) => [p.partNumber, p.url]));

    const uploadPromises: Promise<void>[] = [];

    for await (const { index, data } of splitStream(
        stream,
        partSize,
        UPLOAD_LIMITS.MIN_PART_SIZE,
    )) {
        const partNumber = index + 1; // S3 part numbers are 1-based
        const partUrl = partUrlMap.get(partNumber);
        if (!partUrl) {
            throw new Error(`No pre-signed URL for part ${partNumber}`);
        }

        await semaphore.acquire();

        const promise = (async () => {
            let retries = 0;
            let lastError: Error | null = null;

            while (retries <= MAX_RETRIES) {
                try {
                    // Upload with stall detection
                    const etag = await Promise.race([
                        uploadPart(partUrl, data, data.length),
                        stallTimeout(STALL_TIMEOUT_MS),
                    ]);

                    const part = { PartNumber: partNumber, ETag: etag as string };
                    completedParts.push(part);

                    // Update progress
                    loaded += data.length;
                    reportProgress();

                    // Persist completed part for resume
                    if (!noResume) {
                        // Fire-and-forget — don't block the upload pipeline
                        uploadState.updatePart(uploadInfo.id, part).catch(() => {
                            /* best-effort */
                        });
                    }

                    break; // Success
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    retries++;
                    if (retries > MAX_RETRIES) {
                        throw new Error(
                            `Part ${partNumber} failed after ${MAX_RETRIES} retries: ${lastError.message}`,
                        );
                    }
                    // Exponential backoff: 1s, 2s, 4s, 8s, ...
                    const backoff = Math.min(2 ** (retries - 1) * 1000, 30_000);
                    await new Promise((resolve) => setTimeout(resolve, backoff));
                }
            }
        })();

        promise.finally(() => semaphore.release());
        uploadPromises.push(promise);
    }

    // Wait for all uploads to complete
    await Promise.all(uploadPromises);

    // Sort completed parts by number
    completedParts.sort((a, b) => a.PartNumber - b.PartNumber);

    // 6. Complete upload
    onProgress?.({
        loaded: totalSize,
        total: totalSize,
        percentage: 100,
        speed: 0,
        eta: 0,
        phase: 'completing',
    });

    const metadata = { name: fileName, type: 'application/octet-stream' };
    const metadataStr = await buildMetadataString(encrypted, keychain, metadata);
    const authKey = encrypted ? await keychain.authKeyB64() : undefined;

    await completeUpload(server, {
        id: uploadInfo.id,
        metadata: metadataStr,
        authKey,
        actualSize: totalSize,
        parts: completedParts,
    });

    // 7. Clean up resume state
    if (!noResume) {
        await uploadState.remove(uploadInfo.id);
    }

    const duration = (performance.now() - startTime) / 1000;
    return {
        id: uploadInfo.id,
        ownerToken: uploadInfo.owner,
        duration,
        size: totalSize,
    };
}

// ---------------------------------------------------------------------------
// Resume upload
// ---------------------------------------------------------------------------

/**
 * Resume an interrupted multipart upload.
 *
 * Re-reads the file, skips already-uploaded bytes, pipes through encryption
 * (if applicable) with the correct counter offset, requests new pre-signed
 * URLs for the remaining parts, and completes the upload.
 */
export async function executeResumeUpload(
    filePath: string,
    state: PersistedUpload,
    server: string,
    onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
    const startTime = performance.now();

    // 1. Reconstruct keychain if encrypted
    const keychain = new Keychain(state.encrypted ? state.secretKeyB64 : undefined);

    // 2. Find contiguous prefix of completed parts
    const sortedCompleted = [...state.completedParts].sort((a, b) => a.PartNumber - b.PartNumber);
    let contiguousCount = 0;
    for (let i = 0; i < sortedCompleted.length; i++) {
        if (sortedCompleted[i].PartNumber === i + 1) {
            contiguousCount = i + 1;
        } else {
            break;
        }
    }

    // 3. Calculate how many bytes to skip
    const skipBytes = contiguousCount * state.plaintextPartSize;

    // 4. Calculate total size
    const totalSize = state.encrypted ? calculateEncryptedSize(state.fileSize) : state.fileSize;

    // Estimate already-uploaded bytes
    let loaded = contiguousCount * state.partSize;
    const progressStart = performance.now();

    const reportProgress = () => {
        if (!onProgress) {
            return;
        }
        const elapsed = (performance.now() - progressStart) / 1000;
        const speed = elapsed > 0 ? (loaded - contiguousCount * state.partSize) / elapsed : 0;
        const remaining = totalSize - loaded;
        const eta = speed > 0 ? remaining / speed : 0;
        onProgress({
            loaded,
            total: totalSize,
            percentage: totalSize > 0 ? Math.round((loaded / totalSize) * 100) : 0,
            speed,
            eta,
            phase: 'uploading',
        });
    };

    // 5. Request new pre-signed URLs for remaining parts
    const completedPartNumbers = sortedCompleted.slice(0, contiguousCount).map((p) => p.PartNumber);

    const resumeInfo = await apiResumeUpload(server, state.fileId, {
        uploadId: state.uploadId,
        completedPartNumbers,
    });

    // 6. Create file stream, skipping already-uploaded bytes
    const bunFile = Bun.file(filePath);
    let stream: ReadableStream<Uint8Array> = bunFile.slice(skipBytes).stream();

    // 7. Apply encryption with correct counter offset
    if (state.encrypted) {
        const recordsPerPart = Math.ceil(state.plaintextPartSize / ECE_RECORD_SIZE);
        const initialCounter = contiguousCount * recordsPerPart;
        stream = stream.pipeThrough(createEncryptionStream(keychain, initialCounter));
    }

    // 8. Upload remaining parts
    const partSize = resumeInfo.partSize;
    const concurrency = getAdaptiveConcurrency(state.fileSize);
    const semaphore = new Semaphore(concurrency);
    const STALL_TIMEOUT_MS = 60_000;
    const MAX_RETRIES = 10;

    const newCompletedParts: { PartNumber: number; ETag: string }[] = [];
    const partUrlMap = new Map(resumeInfo.parts.map((p) => [p.partNumber, p.url]));
    const uploadPromises: Promise<void>[] = [];

    for await (const { index, data } of splitStream(
        stream,
        partSize,
        UPLOAD_LIMITS.MIN_PART_SIZE,
    )) {
        // Part number offset: starts after contiguous completed parts
        const partNumber = contiguousCount + index + 1;
        const partUrl = partUrlMap.get(partNumber);
        if (!partUrl) {
            throw new Error(`No pre-signed URL for part ${partNumber}`);
        }

        await semaphore.acquire();

        const promise = (async () => {
            let retries = 0;
            let lastError: Error | null = null;

            while (retries <= MAX_RETRIES) {
                try {
                    const etag = await Promise.race([
                        uploadPart(partUrl, data, data.length),
                        stallTimeout(STALL_TIMEOUT_MS),
                    ]);

                    const part = { PartNumber: partNumber, ETag: etag as string };
                    newCompletedParts.push(part);

                    loaded += data.length;
                    reportProgress();

                    uploadState.updatePart(state.fileId, part).catch(() => {
                        /* best-effort */
                    });
                    break;
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    retries++;
                    if (retries > MAX_RETRIES) {
                        throw new Error(
                            `Part ${partNumber} failed after ${MAX_RETRIES} retries: ${lastError.message}`,
                        );
                    }
                    const backoff = Math.min(2 ** (retries - 1) * 1000, 30_000);
                    await new Promise((resolve) => setTimeout(resolve, backoff));
                }
            }
        })();

        promise.finally(() => semaphore.release());
        uploadPromises.push(promise);
    }

    await Promise.all(uploadPromises);

    // 9. Combine all parts and complete
    const allParts = [...sortedCompleted.slice(0, contiguousCount), ...newCompletedParts].sort(
        (a, b) => a.PartNumber - b.PartNumber,
    );

    onProgress?.({
        loaded: totalSize,
        total: totalSize,
        percentage: 100,
        speed: 0,
        eta: 0,
        phase: 'completing',
    });

    const metadata = buildFileMetadata(state.fileName, state.fileSize);
    const metadataStr = await buildMetadataString(state.encrypted, keychain, metadata);
    const authKey = state.encrypted ? await keychain.authKeyB64() : undefined;

    await completeUpload(server, {
        id: state.fileId,
        metadata: metadataStr,
        authKey,
        actualSize: totalSize,
        parts: allParts,
    });

    // 10. Clean up resume state
    await uploadState.remove(state.fileId);

    const duration = (performance.now() - startTime) / 1000;
    return {
        id: state.fileId,
        ownerToken: state.ownerToken,
        duration,
        size: totalSize,
    };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/** Promise that rejects after `ms` milliseconds with a stall error. */
function stallTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Upload stalled — no progress')), ms);
    });
}

/** Concatenate an array of Uint8Arrays into a single Uint8Array. */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    let totalLength = 0;
    for (const arr of arrays) {
        totalLength += arr.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
