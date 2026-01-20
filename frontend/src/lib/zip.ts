/**
 * Zip utilities for handling multiple file downloads
 */

import JSZip from 'jszip';

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
 */
export async function createZipFromFiles(fileSlices: FileSlice[]): Promise<Blob> {
  const zip = new JSZip();

  // Handle duplicate filenames
  const dedupedSlices = deduplicateFilenames(fileSlices);

  for (const slice of dedupedSlices) {
    zip.file(slice.name, slice.data);
  }

  return zip.generateAsync({ type: 'blob' });
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
