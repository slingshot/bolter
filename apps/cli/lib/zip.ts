/**
 * Multi-file archiving using `archiver` with DEFLATE compression.
 * Creates temporary zip files for multi-file uploads.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, parse as parsePath } from 'node:path';
import archiver from 'archiver';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a zip archive from multiple file paths.
 *
 * @param filePaths  - Absolute paths to the files to include
 * @param onProgress - Optional callback reporting compression progress (0-100)
 * @returns Path to the temporary zip, its size, and the generated filename
 */
export async function zipFiles(
    filePaths: string[],
    onProgress?: (percent: number) => void,
): Promise<{ path: string; size: number; filename: string }> {
    const filename = generateZipFilename(filePaths);
    const tempPath = join(tmpdir(), `bolter-${randomBytes(4).toString('hex')}.zip`);

    // Calculate total input size for progress reporting
    let totalInputSize = 0;
    for (const fp of filePaths) {
        const s = await stat(fp);
        totalInputSize += s.size;
    }

    const archive = archiver('zip', {
        zlib: { level: 6 },
    });

    const output = createWriteStream(tempPath);

    // Track progress
    if (onProgress && totalInputSize > 0) {
        archive.on('progress', (progress) => {
            const percent = Math.min(
                100,
                Math.round((progress.fs.processedBytes / totalInputSize) * 100),
            );
            onProgress(percent);
        });
    }

    // Pipe archive data to the output file
    archive.pipe(output);

    // Append each file
    for (const filePath of filePaths) {
        archive.file(filePath, { name: basename(filePath) });
    }

    // Finalize the archive
    archive.finalize();

    // Wait for the output stream to finish writing
    await new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
    });

    // Get final size
    const finalStat = await stat(tempPath);

    return {
        path: tempPath,
        size: finalStat.size,
        filename,
    };
}

/**
 * Generate a descriptive zip filename based on the input file paths.
 *
 * - 1 file:   "filename.zip"
 * - 2-3 files: "file1-file2-file3.zip" (basenames without extensions, truncated to 40 chars)
 * - 4+ files:  "N-files.zip"
 */
export function generateZipFilename(filePaths: string[]): string {
    if (filePaths.length === 0) {
        return 'archive.zip';
    }

    if (filePaths.length === 1) {
        const name = basename(filePaths[0]);
        return `${name}.zip`;
    }

    if (filePaths.length <= 3) {
        const stems = filePaths.map((fp) => parsePath(fp).name);
        const joined = stems.join('-');
        // Truncate overly long names
        const truncated = joined.length > 40 ? joined.slice(0, 40) : joined;
        return `${truncated}.zip`;
    }

    return `${filePaths.length}-files.zip`;
}

/**
 * Clean up a temporary file (safe to call even if the file doesn't exist).
 */
export async function cleanupTempFile(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch {
        // File may already be gone — ignore
    }
}
