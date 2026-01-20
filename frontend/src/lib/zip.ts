/**
 * Zip utilities for handling file uploads and downloads
 */

import JSZip from 'jszip';
import { downloadZip } from 'client-zip';

export interface FileInfo {
  name: string;
  size: number;
  type: string;
}

export interface FileSlice {
  name: string;
  data: Uint8Array;
  type: string;
}

/**
 * Read a file with streaming progress
 */
async function readFileWithProgress(
  file: File,
  onProgress: (bytesRead: number) => void
): Promise<Uint8Array> {
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let totalRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    totalRead += value.length;
    onProgress(totalRead);
  }

  // Combine chunks
  const result = new Uint8Array(totalRead);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Create a zip blob from File objects (for upload-time zipping)
 * Uses DEFLATE compression for smaller upload size
 * Progress is byte-based: 0-50% for reading files, 50-100% for compression
 */
export async function createZipFromUploadFiles(
  files: File[],
  onProgress?: (percent: number) => void
): Promise<{ blob: Blob; filename: string }> {
  const zip = new JSZip();
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  let totalBytesRead = 0;

  // Handle duplicate filenames
  const nameCount: Record<string, number> = {};

  // Read files with streaming progress tracking (0-50%)
  for (const file of files) {
    let name = file.name;

    if (nameCount[name] !== undefined) {
      const lastDot = name.lastIndexOf('.');
      const baseName = lastDot > 0 ? name.slice(0, lastDot) : name;
      const extension = lastDot > 0 ? name.slice(lastDot) : '';
      nameCount[name]++;
      name = `${baseName} (${nameCount[name]})${extension}`;
    } else {
      nameCount[name] = 0;
    }

    // Read file with progress
    const baseBytes = totalBytesRead;
    const buffer = await readFileWithProgress(file, (bytesRead) => {
      // Report reading progress (0-50% of total)
      onProgress?.(Math.round(((baseBytes + bytesRead) / totalSize) * 50));
    });
    totalBytesRead += file.size;

    // Add to zip with DEFLATE compression
    zip.file(name, buffer, { compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  // Generate zip with progress tracking (50-100%)
  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      // Report compression progress (50-100% of total)
      onProgress?.(50 + Math.round(metadata.percent / 2));
    }
  );

  const filename = generateZipFilename(files.map(f => ({ name: f.name, size: f.size, type: f.type })));

  return { blob, filename };
}

/**
 * Create a streaming zip from File objects
 * Uses client-zip which streams data without buffering the entire zip in memory
 * This is suitable for large files (multi-GB) that would exceed browser memory limits
 *
 * Note: client-zip uses STORE compression (no compression) for streaming capability
 */
export function createStreamingZip(
  files: File[],
  onProgress?: (bytesProcessed: number, totalBytes: number) => void
): { stream: ReadableStream<Uint8Array>; filename: string; estimatedSize: number } {
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  let bytesProcessed = 0;

  // Handle duplicate filenames
  const nameCount: Record<string, number> = {};
  const renamedFiles: { name: string; input: File }[] = [];

  for (const file of files) {
    let name = file.name;

    if (nameCount[name] !== undefined) {
      const lastDot = name.lastIndexOf('.');
      const baseName = lastDot > 0 ? name.slice(0, lastDot) : name;
      const extension = lastDot > 0 ? name.slice(lastDot) : '';
      nameCount[name]++;
      name = `${baseName} (${nameCount[name]})${extension}`;
    } else {
      nameCount[name] = 0;
    }

    renamedFiles.push({ name, input: file });
  }

  // Create file entries with progress tracking
  // Each entry wraps the file stream with progress reporting
  const entries = renamedFiles.map(({ name, input }) => ({
    name,
    lastModified: new Date(input.lastModified),
    input: createProgressStream(input.stream(), input.size, (bytes) => {
      bytesProcessed += bytes;
      onProgress?.(bytesProcessed, totalSize);
    }),
  }));

  // Use client-zip to create the streaming zip
  const response = downloadZip(entries);
  const stream = response.body!;

  // Estimate zip size (STORE compression = input size + ~100 bytes per file for headers)
  const estimatedSize = totalSize + files.length * 100 + 22; // 22 bytes for end of central directory

  const filename = generateZipFilename(files.map(f => ({ name: f.name, size: f.size, type: f.type })));

  return { stream, filename, estimatedSize };
}

/**
 * Wrap a stream to track bytes read for progress reporting
 */
function createProgressStream(
  stream: ReadableStream<Uint8Array>,
  _totalSize: number,
  onBytes: (bytes: number) => void
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      onBytes(value.length);
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });
}

/**
 * Slice concatenated data back into individual files using metadata
 */
export function sliceConcatenatedData(data: Uint8Array, files: FileInfo[]): FileSlice[] {
  const totalExpectedSize = files.reduce((sum, f) => sum + f.size, 0);

  if (data.length !== totalExpectedSize) {
    console.warn(
      `[sliceConcatenatedData] Size mismatch: got ${data.length} bytes, expected ${totalExpectedSize}`
    );
  }

  const slices: FileSlice[] = [];
  let offset = 0;

  for (const file of files) {
    const end = Math.min(offset + file.size, data.length);
    const slice = data.slice(offset, end);

    slices.push({
      name: file.name,
      data: slice,
      type: file.type,
    });

    offset = end;
  }

  return slices;
}

/**
 * Handle duplicate filenames by appending (1), (2), etc.
 */
function deduplicateFilenames(slices: FileSlice[]): FileSlice[] {
  const nameCount: Record<string, number> = {};

  return slices.map(slice => {
    let name = slice.name;

    if (nameCount[name] !== undefined) {
      // Split name and extension
      const lastDot = name.lastIndexOf('.');
      const baseName = lastDot > 0 ? name.slice(0, lastDot) : name;
      const extension = lastDot > 0 ? name.slice(lastDot) : '';

      nameCount[name]++;
      name = `${baseName} (${nameCount[name]})${extension}`;
    } else {
      nameCount[name] = 0;
    }

    return { ...slice, name };
  });
}

/**
 * Create a zip blob from file slices
 * Uses STORE compression (no compression) to reduce memory usage for large files
 */
export async function createZipFromFiles(fileSlices: FileSlice[]): Promise<Blob> {
  const zip = new JSZip();

  // Handle duplicate filenames
  const dedupedSlices = deduplicateFilenames(fileSlices);

  for (const slice of dedupedSlices) {
    // Use STORE compression (level 0) to minimize memory usage
    zip.file(slice.name, slice.data, { compression: 'STORE' });
  }

  try {
    return await zip.generateAsync({
      type: 'blob',
      compression: 'STORE', // No compression to save memory
      streamFiles: true, // Stream files to reduce memory peaks
    });
  } catch (error: any) {
    // If blob creation fails due to memory, throw a more helpful error
    if (error.message?.includes("can't construct the Blob")) {
      throw new Error('Download too large for browser. Try downloading fewer files at once.');
    }
    throw error;
  }
}

/**
 * Generate a sensible zip filename from the list of files
 */
export function generateZipFilename(files: FileInfo[]): string {
  if (files.length === 0) {
    return 'download.zip';
  }

  if (files.length === 1) {
    // Shouldn't happen for multi-file, but handle gracefully
    const name = files[0].name;
    const lastDot = name.lastIndexOf('.');
    const baseName = lastDot > 0 ? name.slice(0, lastDot) : name;
    return `${baseName}.zip`;
  }

  // Find common prefix among filenames
  const names = files.map(f => f.name);
  const commonPrefix = findCommonPrefix(names);

  if (commonPrefix.length >= 3) {
    // Use common prefix if it's meaningful (at least 3 chars)
    return `${commonPrefix.replace(/[_\-\s]+$/, '')}.zip`;
  }

  // Otherwise use generic name with file count
  return `files-${files.length}.zip`;
}

/**
 * Find common prefix among an array of strings
 */
function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  if (strings.length === 1) return strings[0];

  let prefix = '';
  const first = strings[0];

  for (let i = 0; i < first.length; i++) {
    const char = first[i];
    if (strings.every(s => s[i] === char)) {
      prefix += char;
    } else {
      break;
    }
  }

  return prefix;
}
