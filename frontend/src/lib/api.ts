/**
 * API utilities for file upload and download
 * Implements resilient direct-to-cloudflare multipart uploads
 */

import { Keychain, arrayToB64, b64ToArray, calculateEncryptedSize, createEncryptionStream } from './crypto';
import { sliceConcatenatedData, createZipFromFiles, createZipFromUploadFiles, createStreamingZip, generateZipFilename, type FileInfo } from './zip';
import { UPLOAD_LIMITS } from '@bolter/shared';

// Threshold for using streaming zip (500MB) - below this, buffered zip is fine
const STREAMING_ZIP_THRESHOLD = 500 * 1024 * 1024;

// API base URL - defaults to localhost for development
export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Retry configuration
const MAX_RETRIES = 10;
const RETRY_DELAY_BASE = 2000; // 2 seconds
const MAX_RETRY_DELAY = 60000; // 60 seconds

// Adaptive concurrency based on file size
// With backpressure, memory is bounded to ~(concurrency + 1) * partSize
// e.g., concurrency 3 with 200MB parts = max ~800MB buffered
function getConcurrentUploads(fileSize: number): number {
  const GB = 1024 * 1024 * 1024;
  if (fileSize > 50 * GB) return 2;   // > 50GB: conservative
  return 3;                            // default: 3 concurrent uploads
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
  speed: number; // bytes per second
  remainingTime: number; // seconds
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
  if (!response.ok) throw new Error('Failed to fetch config');
  return response.json();
}

/**
 * Check if file exists
 */
export async function fileExists(id: string): Promise<boolean> {
  const response = await fetch(`${API_BASE_URL}/exists/${id}`);
  if (!response.ok) return false;
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
    if (!response.ok) return null;
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
    headers['Authorization'] = await keychain.authHeader();
  }

  let response = await fetch(`${API_BASE_URL}/metadata/${id}`, { headers });

  // Handle 401 challenge-response: extract nonce and retry
  if (response.status === 401 && keychain) {
    const authHeader = response.headers.get('WWW-Authenticate');
    if (authHeader) {
      const nonce = authHeader.split(' ')[1];
      if (nonce) {
        keychain.nonce = nonce;
        headers['Authorization'] = await keychain.authHeader();
        response = await fetch(`${API_BASE_URL}/metadata/${id}`, { headers });
      }
    }
  }

  // Extract nonce for future requests
  const authHeader = response.headers.get('WWW-Authenticate');
  if (authHeader && keychain) {
    const nonce = authHeader.split(' ')[1];
    if (nonce) keychain.nonce = nonce;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
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
      throw e;
    }
  } else {
    // Unencrypted metadata - decode from base64
    console.log('[getMetadata] Decoding unencrypted metadata');
    try {
      // Handle URL-safe base64 by converting to standard base64
      const standardB64 = data.metadata
        .replace(/-/g, '+')
        .replace(/_/g, '/');
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
export async function getFileInfo(id: string, ownerToken: string): Promise<{
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
    if (!response.ok) return null;
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
    if (!response.ok) return null;
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
  canceller: Canceller
): Promise<UploadResult> {
  const { files, encrypted = true, timeLimit, downloadLimit, onProgress, onZipProgress, onError } = options;

  const startTime = Date.now();
  let lastProgressTime = startTime;
  let lastProgressBytes = 0;
  let lastDisplayTime = startTime;
  let smoothedSpeed = 0;
  let smoothedRemaining = 0;

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

  let uploadInfo: UploadUrlResponse = await uploadResponse.json();

  if (!uploadInfo.useSignedUrl) {
    throw new Error('Pre-signed URLs not available');
  }

  // Track progress
  const partProgress: Record<number, number> = {};
  const updateProgress = (partNum: number, loaded: number) => {
    partProgress[partNum] = loaded;
    const totalLoaded = Object.values(partProgress).reduce((sum, p) => sum + p, 0);

    const now = Date.now();
    const elapsed = (now - lastProgressTime) / 1000;
    const bytesInPeriod = totalLoaded - lastProgressBytes;
    const instantSpeed = elapsed > 0 ? bytesInPeriod / elapsed : 0;

    // Update speed/time calculation once per second with smoothing
    const displayElapsed = (now - lastDisplayTime) / 1000;
    if (displayElapsed >= 1 || lastDisplayTime === startTime) {
      // Exponential moving average for smooth speed (alpha = 0.3)
      smoothedSpeed = smoothedSpeed === 0 ? instantSpeed : smoothedSpeed * 0.7 + instantSpeed * 0.3;
      smoothedRemaining = smoothedSpeed > 0 ? (totalSize - totalLoaded) / smoothedSpeed : 0;
      lastDisplayTime = now;
      lastProgressTime = now;
      lastProgressBytes = totalLoaded;
    }

    // Always update progress bar, but speed/time stay stable between updates
    onProgress?.({
      loaded: Math.min(totalLoaded, totalSize),
      total: totalSize,
      percentage: Math.min((totalLoaded / totalSize) * 100, 100),
      speed: smoothedSpeed,
      remainingTime: smoothedRemaining,
    });
  };

  let uploadResult: { actualSize: number; parts?: { PartNumber: number; ETag: string }[] };

  if (uploadInfo.multipart && uploadInfo.parts) {
    // Multipart upload
    const multipartResult = await uploadMultipartStream(
      stream,
      uploadInfo,
      updateProgress,
      canceller,
      onError,
      totalSize
    );

    // Handle fallback: stream produced too little data for multipart
    if ('fallbackBlob' in multipartResult) {
      console.log(`[Upload] Falling back to single-part upload (${(multipartResult.fallbackBlob.size / 1024).toFixed(1)}KB)`);

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
        fallbackInfo.url!,
        (loaded) => updateProgress(1, loaded),
        canceller
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
      canceller
    );
  }

  if (canceller.cancelled) {
    if (uploadInfo.multipart && uploadInfo.uploadId) {
      await abortMultipartUpload(uploadInfo.id, uploadInfo.uploadId);
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
    throw new Error(`Failed to complete upload: ${errorText}`);
  }

  const completeInfo = await completeResponse.json();

  // Always use frontend origin for download URL (backend may return its own URL)
  // Don't include hash here - ShareDialog will append the secretKey
  const downloadUrl = `${window.location.origin}/download/${uploadInfo.id}`;

  return {
    id: uploadInfo.id,
    url: downloadUrl,
    ownerToken: uploadInfo.owner,
    duration: Date.now() - startTime,
  };
}

/**
 * Create a readable stream from files
 */
function createFileStream(
  files: File[],
  keychain: Keychain,
  encrypt: boolean
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
          currentReader = currentFile.stream().getReader();
        }

        const { done, value } = await currentReader.read();
        if (done) {
          currentReader = null;
          continue;
        }

        controller.enqueue(value);
        return;
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
  encrypt: boolean
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
async function uploadSinglePart(
  blob: Blob,
  url: string,
  onProgress: (loaded: number) => void,
  canceller: Canceller
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
        reject(new Error(`HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => {
      canceller.removeXhr(xhr);
      reject(new Error('Network error'));
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
  totalFileSize?: number
): Promise<MultipartStreamResult> {
  const { parts, partSize } = uploadInfo;
  if (!parts || !partSize) throw new Error('Invalid upload info');

  const MIN_PART = UPLOAD_LIMITS.MIN_PART_SIZE;

  // Adaptive concurrency based on file size
  const maxConcurrent = getConcurrentUploads(totalFileSize || 0);
  console.log(`[Upload] Starting multipart upload: ${parts.length} parts, ${partSize / (1024*1024)}MB each, concurrency: ${maxConcurrent}`);

  const reader = stream.getReader();
  const completedParts: { PartNumber: number; ETag: string }[] = [];
  const partErrors: Record<number, { error: string; size: number }> = {};
  const failedPartNumbers: number[] = [];

  // Concurrency control state
  let activeUploads = 0;
  let totalUploadedSize = 0;
  let totalPartsQueued = 0;
  let totalPartsFinished = 0;

  // Promise to signal when all uploads are done
  let resolveAllDone: () => void;
  const allDonePromise = new Promise<void>(resolve => { resolveAllDone = resolve; });

  // Upload a single part and manage concurrency
  const doUploadPart = async (partBlob: Blob, partNum: number, partUrl: string): Promise<void> => {
    try {
      console.log(`[Upload] Part ${partNum} starting (${(partBlob.size / (1024*1024)).toFixed(1)}MB)`);
      const result = await uploadPartWithRetry(
        partBlob,
        partUrl,
        partNum,
        (loaded) => onProgress(partNum, loaded),
        canceller
      );
      completedParts.push(result);
      console.log(`[Upload] Part ${partNum} complete`);
    } catch (error: any) {
      console.error(`[Upload] Part ${partNum} failed:`, error.message);
      partErrors[partNum] = {
        error: error.message,
        size: partBlob.size,
      };
      failedPartNumbers.push(partNum);
    } finally {
      activeUploads--;
      totalPartsFinished++;
      console.log(`[Upload] Progress: ${totalPartsFinished}/${totalPartsQueued} parts finished, ${activeUploads} active`);

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
      const item = pendingQueue.shift()!;
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
      // Queue the previously buffered part — it's not the last
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
      while (currentPartSize < partSize && !streamDone) {
        const { done, value } = await reader.read();

        if (done) {
          streamDone = true;
          break;
        }

        if (canceller.cancelled) {
          throw new Error('Upload cancelled');
        }

        const wouldExceed = currentPartSize + value.length > partSize;

        if (wouldExceed && currentPartIndex < parts.length - 1) {
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
          await new Promise<void>(resolve => {
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

    // Stream is done — flush the buffered item
    if (bufferedItem) {
      // Check if we only have 1 part total and it's too small for multipart
      const noPriorParts = totalPartsQueued === 0 && activeUploads === 0;

      if (noPriorParts && bufferedItem.blob.size < MIN_PART) {
        // Entire stream output is a single tiny blob — fallback to single-part upload
        console.log(`[Upload] Stream produced only ${(bufferedItem.blob.size / 1024).toFixed(1)}KB — falling back to single-part upload`);
        return { fallbackBlob: bufferedItem.blob };
      }

      // Check if final part is too small and we can merge it with a pending part
      if (bufferedItem.blob.size < MIN_PART && pendingQueue.length > 0) {
        // Merge with the last pending part
        const lastPending = pendingQueue[pendingQueue.length - 1];
        const mergedBlob = new Blob([lastPending.blob, bufferedItem.blob]);
        console.log(`[Upload] Merging small final part (${(bufferedItem.blob.size / 1024).toFixed(1)}KB) into part ${lastPending.partNum} (${(lastPending.blob.size / (1024*1024)).toFixed(1)}MB → ${(mergedBlob.size / (1024*1024)).toFixed(1)}MB)`);
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
      console.log(`[Upload] Waiting for ${totalPartsQueued - totalPartsFinished} remaining uploads...`);
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
  retryCount = 0
): Promise<{ PartNumber: number; ETag: string }> {
  try {
    return await uploadPart(blob, url, partNumber, onProgress, canceller);
  } catch (error: any) {
    if (canceller.cancelled) throw error;

    const isRetryable = isRetryableError(error);
    console.warn(`[Upload] Part ${partNumber} failed (attempt ${retryCount + 1}/${MAX_RETRIES + 1}): ${error.message}`, {
      retryable: isRetryable,
      blobSize: blob.size,
    });

    if (retryCount < MAX_RETRIES && isRetryable) {
      const delay = Math.min(
        RETRY_DELAY_BASE * Math.pow(2, retryCount) + Math.random() * 1000,
        MAX_RETRY_DELAY
      );

      console.log(`[Upload] Retrying part ${partNumber} in ${(delay/1000).toFixed(1)}s...`);

      await new Promise((resolve) => setTimeout(resolve, delay));

      if (canceller.cancelled) throw new Error('Upload cancelled');

      onProgress(0); // Reset progress
      return uploadPartWithRetry(blob, url, partNumber, onProgress, canceller, retryCount + 1);
    }

    throw error;
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
  canceller: Canceller
): Promise<{ PartNumber: number; ETag: string }> {
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
        const etag = xhr.getResponseHeader('ETag') || '';
        resolve({ PartNumber: partNumber, ETag: etag });
      } else {
        let errorDetails = `HTTP ${xhr.status}`;
        if (xhr.statusText) errorDetails += ` (${xhr.statusText})`;
        if (xhr.responseText) errorDetails += `: ${xhr.responseText.substring(0, 200)}`;
        reject(new Error(errorDetails));
      }
    });

    xhr.addEventListener('error', () => {
      canceller.removeXhr(xhr);
      reject(new Error('Network error'));
    });

    xhr.addEventListener('timeout', () => {
      canceller.removeXhr(xhr);
      reject(new Error('Timeout'));
    });

    xhr.open('PUT', url);
    xhr.timeout = 120000; // 2 minute timeout
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
  }
}

/**
 * Fetch with retry logic
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (e: any) {
      lastError = e;
      if (i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
      }
    }
  }

  throw lastError || new Error('Fetch failed');
}

/**
 * Download a file
 */
export async function downloadFile(
  id: string,
  keychain: Keychain | null,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ blob: Blob; filename: string }> {
  // Get metadata first
  const metadata = await getMetadata(id, keychain || undefined);

  // Get download URL
  const headers: Record<string, string> = {};
  if (keychain) {
    headers['Authorization'] = await keychain.authHeader();
  }

  let urlResponse = await fetch(`${API_BASE_URL}/download/url/${id}`, { headers });

  // Handle 401 challenge-response: extract nonce and retry
  if (urlResponse.status === 401 && keychain) {
    const authHeader = urlResponse.headers.get('WWW-Authenticate');
    if (authHeader) {
      const nonce = authHeader.split(' ')[1];
      if (nonce) {
        keychain.nonce = nonce;
        headers['Authorization'] = await keychain.authHeader();
        urlResponse = await fetch(`${API_BASE_URL}/download/url/${id}`, { headers });
      }
    }
  }

  // Extract nonce for future requests
  if (keychain) {
    const authHeader = urlResponse.headers.get('WWW-Authenticate');
    if (authHeader) {
      const nonce = authHeader.split(' ')[1];
      if (nonce) keychain.nonce = nonce;
    }
  }

  if (!urlResponse.ok) {
    throw new Error(`HTTP ${urlResponse.status}`);
  }

  const urlData = await urlResponse.json();

  // Download from signed URL or stream
  const downloadUrl = urlData.useSignedUrl ? urlData.url : `${API_BASE_URL}/download/${id}`;
  const downloadHeaders: Record<string, string> = {};

  if (!urlData.useSignedUrl && keychain) {
    downloadHeaders['Authorization'] = await keychain.authHeader();
  }

  let response = await fetch(downloadUrl, { headers: downloadHeaders });

  // Handle 401 challenge-response for direct downloads
  if (response.status === 401 && keychain && !urlData.useSignedUrl) {
    const authHeader = response.headers.get('WWW-Authenticate');
    if (authHeader) {
      const nonce = authHeader.split(' ')[1];
      if (nonce) {
        keychain.nonce = nonce;
        downloadHeaders['Authorization'] = await keychain.authHeader();
        response = await fetch(downloadUrl, { headers: downloadHeaders });
      }
    }
  }

  // Extract nonce for future requests
  if (keychain && !urlData.useSignedUrl) {
    const authHeader = response.headers.get('WWW-Authenticate');
    if (authHeader) {
      const nonce = authHeader.split(' ')[1];
      if (nonce) keychain.nonce = nonce;
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
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
    if (done) break;

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
      }).pipeThrough(decryptStream)
    );
    decryptedData = new Uint8Array(await decryptedResponse.arrayBuffer());
  } else {
    decryptedData = data;
  }

  // Report download complete
  await fetch(`${API_BASE_URL}/download/complete/${id}`, {
    method: 'POST',
    headers: keychain ? { Authorization: await keychain.authHeader() } : {},
  }).catch(console.warn);

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
