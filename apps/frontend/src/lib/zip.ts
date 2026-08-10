/**
 * Zip utilities for handling file uploads and downloads
 */

import { downloadZip, makeZip, predictLength } from 'client-zip';
import JSZip from 'jszip';
import { FileReadError } from './errors';

export interface FileInfo {
    name: string;
    size: number;
    type: string;
}

export interface FileSlice {
    name: string;
    data: Blob | Uint8Array;
    type: string;
}

/**
 * Drop C0 control characters and DEL: they are illegal in zip entry names and
 * let a crafted name hide or spoof its real path in an extractor's output.
 * Filtered by code point rather than a regex literal, since biome forbids
 * control characters inside regex literals.
 */
function stripControlCharacters(value: string): string {
    let stripped = '';
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x20 && code !== 0x7f) {
            stripped += char;
        }
    }
    return stripped;
}

/**
 * Normalize a zip entry name so it can never escape the extraction directory.
 *
 * Entry names on the download path come from uploader-controlled server
 * metadata, and JSZip/client-zip write whatever they are given verbatim into
 * the archive headers. A naive extractor handed `../../../.bashrc` or
 * `/etc/cron.d/x` will happily write outside the target directory (zip slip),
 * so absolute paths, drive prefixes, `.`/`..` segments and control characters
 * are stripped before the name reaches the archive.
 */
export function sanitizeZipEntryName(rawName: string, fallback = 'unnamed'): string {
    // Strip every leading separator and Windows drive prefix in one pass —
    // `C:`, `/C:`, and stacked forms like `C:C:/x`, which a fixed sequence of
    // single replacements would leave a literal `C:` directory segment for.
    // The alternation branches are single-character-ish and unambiguous, so
    // there is no backtracking blowup on a long run of separators.
    const normalized = stripControlCharacters(rawName)
        .replace(/\\/g, '/')
        .replace(/^(?:\/|[A-Za-z]:)+/, '');

    const segments = normalized
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');

    const sanitized = segments.join('/');
    return sanitized === '' ? fallback : sanitized;
}

function splitNameAndExtension(name: string): { baseName: string; extension: string } {
    const lastDot = name.lastIndexOf('.');
    return lastDot > 0
        ? { baseName: name.slice(0, lastDot), extension: name.slice(lastDot) }
        : { baseName: name, extension: '' };
}

/** `report (1)` → stem `report`, next counter `2`; `report` → stem `report`, next `1`. */
function splitDuplicateCounter(baseName: string): { stem: string; nextCounter: number } {
    const match = /^(.*) \((\d+)\)$/.exec(baseName);
    if (!match) {
        return { stem: baseName, nextCounter: 1 };
    }
    return { stem: match[1], nextCounter: Number(match[2]) + 1 };
}

/**
 * Build a stateful de-duplicator for zip entry names.
 *
 * Every name handed out is sanitized and recorded, and generated `base (N).ext`
 * candidates are re-checked against the names already assigned. Registering the
 * generated names is what makes this safe: a counter that only tracks the
 * *original* names will happily mint `report (1).pdf` for the second
 * `report.pdf` and then hand the same string to a genuine `report (1).pdf`,
 * whose `zip.file()` call silently replaces the earlier entry — the archive
 * ships with one file fewer than the metadata advertises, and on the upload
 * path the original bytes are gone for good.
 */
export function createNameDeduplicator(): (rawName: string) => string {
    const assigned = new Set<string>();

    return (rawName: string): string => {
        const name = sanitizeZipEntryName(rawName);
        if (!assigned.has(name)) {
            assigned.add(name);
            return name;
        }

        const { baseName, extension } = splitNameAndExtension(name);
        const { stem, nextCounter } = splitDuplicateCounter(baseName);
        let counter = nextCounter;
        let candidate = `${stem} (${counter})${extension}`;
        while (assigned.has(candidate)) {
            counter++;
            candidate = `${stem} (${counter})${extension}`;
        }

        assigned.add(candidate);
        return candidate;
    };
}

/**
 * Largest value representable in the 32-bit size/offset fields of a plain
 * (non-ZIP64) zip archive.
 */
export const ZIP32_MAX_BYTES = 0xffffffff;

/**
 * Largest entry count representable in the 16-bit end-of-central-directory
 * counters of a plain (non-ZIP64) zip archive.
 */
export const ZIP32_MAX_ENTRIES = 0xffff;

/**
 * Upper-bound the size of a STORE-compressed archive: per entry a local file
 * header (30 bytes + name), a data descriptor (16 bytes) and a central
 * directory record (46 bytes + name), plus the 22-byte end-of-central-directory.
 */
export function projectZipArchiveSize(entries: { name: string; size: number }[]): number {
    const encoder = new TextEncoder();
    let total = 22;
    for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name).length;
        total += 30 + nameBytes + 16 + 46 + nameBytes + entry.size;
    }
    return total;
}

/**
 * Fail loudly when an archive would need ZIP64.
 *
 * JSZip 3.10.1 has no ZIP64 support: it writes sizes and central-directory
 * offsets modulo 2^32 without raising, so an archive crossing 4 GiB
 * "succeeds" and produces a file extractors reject or unpack as garbage.
 * Throwing here keeps the failure ahead of `reportDownloadComplete`, so the
 * download credit is preserved.
 */
export function assertZipFitsWithoutZip64(entries: { name: string; size: number }[]): void {
    // The EOCD entry counters are 16-bit and wrap just as silently as the size
    // fields. The uploader controls the metadata file list and the server does
    // not cap it, so this is reachable from a hand-crafted /upload/complete.
    if (entries.length > ZIP32_MAX_ENTRIES) {
        throw new Error(
            `Cannot build the zip: ${entries.length} files exceeds the ${ZIP32_MAX_ENTRIES}-entry limit of the zip format used here. Download the files individually instead.`,
        );
    }

    for (const entry of entries) {
        if (entry.size >= ZIP32_MAX_BYTES) {
            throw new Error(
                `Cannot build the zip: "${entry.name}" is ${entry.size} bytes, which exceeds the 4 GiB per-entry limit of the zip format used here. Download the files individually instead.`,
            );
        }
    }

    const projectedSize = projectZipArchiveSize(entries);
    if (projectedSize >= ZIP32_MAX_BYTES) {
        throw new Error(
            `Cannot build the zip: the archive would be ${projectedSize} bytes, which exceeds the 4 GiB limit of the zip format used here. Download the files individually instead.`,
        );
    }
}

/**
 * Read a file with streaming progress
 */
async function readFileWithProgress(
    file: File,
    onProgress: (bytesRead: number) => void,
): Promise<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
        reader = file.stream().getReader();
    } catch (e) {
        throw new FileReadError(file.name, e);
    }
    const chunks: Uint8Array[] = [];
    let totalRead = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            chunks.push(value);
            totalRead += value.length;
            onProgress(totalRead);
        }
    } catch (e) {
        throw new FileReadError(file.name, e);
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
    onProgress?: (percent: number) => void,
): Promise<{ blob: Blob; filename: string }> {
    const zip = new JSZip();
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    let totalBytesRead = 0;

    // Handle duplicate filenames (collision-safe: generated names are registered too)
    const nextEntryName = createNameDeduplicator();

    // Read files with streaming progress tracking (0-50%)
    for (const file of files) {
        const name = nextEntryName(file.name);

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
        },
    );

    const filename = generateZipFilename(
        files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    );

    return { blob, filename };
}

export interface StreamingZip {
    stream: ReadableStream<Uint8Array>;
    filename: string;
    estimatedSize: number;
    /**
     * Release every per-file source stream held by the zip.
     *
     * MUST be called by the consumer when the upload is cancelled or fails —
     * neither client-zip's cancel handler (a no-op for plain-Array entries) nor
     * `releaseLock()` on the zip stream reaches the wrapped file streams.
     * Never rejects.
     */
    dispose: () => Promise<void>;
}

export interface StreamingZipOptions {
    /**
     * Override the per-file byte source. When provided, each entry's input
     * stream comes from this factory instead of `file.stream()` — the worker
     * upload engine injects slice-backed streams here. The returned stream is
     * still wrapped for progress reporting and dispose() cancellation.
     */
    streamFactory?: (file: File) => ReadableStream<Uint8Array>;
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
    onProgress?: (bytesProcessed: number, totalBytes: number) => void,
    opts?: StreamingZipOptions,
): StreamingZip {
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    let bytesProcessed = 0;

    // Handle duplicate filenames (collision-safe: generated names are registered too)
    const nextEntryName = createNameDeduplicator();
    const renamedFiles: { name: string; input: File }[] = files.map((file) => ({
        name: nextEntryName(file.name),
        input: file,
    }));

    // Create file entries with progress tracking
    // Each entry wraps the file stream with progress reporting. The wrapper
    // acquires its reader lazily, so constructing the zip does not lock every
    // source stream up front, and every wrapper is retained so dispose() can
    // cancel it when the upload is cancelled.
    const progressHandles: ProgressStreamHandle[] = [];
    let entries: { name: string; lastModified: Date; input: ReadableStream<Uint8Array> }[];
    try {
        entries = renamedFiles.map(({ name, input }) => {
            let fileStream: ReadableStream<Uint8Array>;
            try {
                fileStream = opts?.streamFactory?.(input) ?? input.stream();
            } catch (e) {
                throw new FileReadError(input.name, e);
            }
            const handle = createProgressStream(fileStream, input.size, (bytes) => {
                bytesProcessed += bytes;
                onProgress?.(bytesProcessed, totalSize);
            });
            progressHandles.push(handle);
            return {
                name,
                lastModified: new Date(input.lastModified),
                input: handle.stream,
            };
        });
    } catch (e) {
        // Don't strand the wrappers created before the failing file.
        void Promise.all(progressHandles.map((handle) => handle.cancel()));
        throw e;
    }

    // Use client-zip to create the streaming zip
    const response = downloadZip(entries);
    const stream = response.body ?? new ReadableStream<Uint8Array>();

    // Use client-zip's predictLength for exact ZIP size calculation
    // This uses the same internal logic as downloadZip, accounting for all ZIP
    // structure overhead (headers, central directory, Zip64 extensions, etc.)
    const metadata = renamedFiles.map(({ name, input }) => ({ name, size: input.size }));
    const estimatedSize = Number(predictLength(metadata));

    const filename = generateZipFilename(
        files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    );

    // client-zip's own cancel handler is a no-op for plain-Array entries, and
    // the upload path only releases its lock on cancel — so nothing would ever
    // reach the per-file streams. dispose() is that missing link.
    const dispose = async (): Promise<void> => {
        await Promise.all(progressHandles.map((handle) => handle.cancel()));
        // Drop the client-zip output too when nothing holds a lock on it (the
        // consumer releases its reader on cancel), so the suspended generator
        // is torn down rather than left for GC. Deliberately not awaited:
        // dispose() runs on the upload's cancellation path and must never be
        // able to hang it inside a third-party stream's cancel algorithm.
        if (!stream.locked) {
            try {
                void stream.cancel().catch(() => {
                    // Best-effort cleanup — an already errored stream is fine.
                });
            } catch {
                // cancel() throws synchronously if the stream got locked in
                // between; the per-file sources are already released.
            }
        }
    };

    return { stream, filename, estimatedSize, dispose };
}

interface ProgressStreamHandle {
    stream: ReadableStream<Uint8Array>;
    /** Cancels the wrapped source stream (and its reader, if one was acquired). */
    cancel: (reason?: unknown) => Promise<void>;
}

/**
 * Wrap a stream to track bytes read for progress reporting.
 *
 * The source reader is acquired on the first pull rather than eagerly, so a
 * zip whose entries are never consumed leaves its source streams unlocked.
 * The wrapper is built with `highWaterMark: 0` for that to mean anything: the
 * default strategy (highWaterMark 1) makes a ReadableStream pull one chunk as
 * soon as it is constructed, so every source would be read from — and locked —
 * a microtask after `createStreamingZip` returned, no matter how lazy `pull`
 * itself is. With a highWaterMark of 0, `pull` only runs once a consumer
 * actually asks for bytes.
 */
function createProgressStream(
    stream: ReadableStream<Uint8Array>,
    _totalSize: number,
    onBytes: (bytes: number) => void,
): ProgressStreamHandle {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let cancelled = false;

    const cancel = async (reason?: unknown): Promise<void> => {
        cancelled = true;
        const active = reader;
        reader = null;
        try {
            // Cancel through the reader when one exists (the stream is locked
            // to it); otherwise cancel the unlocked source directly.
            await (active ? active.cancel(reason) : stream.cancel(reason));
        } catch {
            // Best-effort cleanup — an already errored/closed stream is fine.
        }
    };

    const progressStream = new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                if (cancelled) {
                    controller.close();
                    return;
                }
                if (!reader) {
                    reader = stream.getReader();
                }
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    return;
                }
                onBytes(value.length);
                controller.enqueue(value);
            },
            cancel(reason) {
                return cancel(reason);
            },
        },
        { highWaterMark: 0 },
    );

    return { stream: progressStream, cancel };
}

export interface SliceOptions {
    /**
     * When false, a payload/metadata size mismatch warns and slices are
     * clamped to the available bytes instead of throwing — legacy uploads
     * (iOS lazy transcoding) can have drifted metadata sizes and best-effort
     * delivery beats a permanently failing download.
     */
    strict?: boolean;
}

/**
 * Slice concatenated data back into individual files using metadata
 */
export function sliceConcatenatedData(
    data: Uint8Array,
    files: FileInfo[],
    options: SliceOptions = {},
): FileSlice[] {
    const { strict = true } = options;
    const totalExpectedSize = files.reduce((sum, f) => sum + f.size, 0);

    if (data.length !== totalExpectedSize) {
        const message = `[sliceConcatenatedData] Size mismatch: got ${data.length} bytes, expected ${totalExpectedSize}`;
        if (strict) {
            throw new Error(message);
        }
        console.warn(message);
    }

    const slices: FileSlice[] = [];
    let offset = 0;

    for (const file of files) {
        const end = Math.min(offset + file.size, data.length);
        slices.push({
            name: file.name,
            data: data.slice(Math.min(offset, data.length), end),
            type: file.type,
        });
        offset += file.size;
    }

    return slices;
}

/**
 * Slice concatenated data held in a Blob back into individual files.
 * Blob.slice is zero-copy, so this avoids materializing the payload in JS heap.
 */
export function sliceConcatenatedBlob(
    data: Blob,
    files: FileInfo[],
    options: SliceOptions = {},
): FileSlice[] {
    const { strict = true } = options;
    const totalExpectedSize = files.reduce((sum, f) => sum + f.size, 0);

    if (data.size !== totalExpectedSize) {
        const message = `[sliceConcatenatedData] Size mismatch: got ${data.size} bytes, expected ${totalExpectedSize}`;
        if (strict) {
            throw new Error(message);
        }
        console.warn(message);
    }

    const slices: FileSlice[] = [];
    let offset = 0;

    for (const file of files) {
        // Blob.slice clamps out-of-range offsets natively
        const end = offset + file.size;
        slices.push({
            name: file.name,
            data: data.slice(offset, end, file.type),
            type: file.type,
        });
        offset = end;
    }

    return slices;
}

/**
 * Sanitize entry names and handle duplicates by appending (1), (2), etc.
 */
function deduplicateFilenames(slices: FileSlice[]): FileSlice[] {
    const nextEntryName = createNameDeduplicator();
    return slices.map((slice) => ({ ...slice, name: nextEntryName(slice.name) }));
}

function entryByteLength(data: Blob | Uint8Array): number {
    return data instanceof Blob ? data.size : data.byteLength;
}

/**
 * Sanitize entry names and handle duplicates by appending (1), (2), etc.
 *
 * Delegates to the same collision-proof deduplicator the slice-based paths use,
 * so the streaming zip inherits its sanitization and its guarantee that a
 * generated `base (N).ext` can never collide with a real entry of that name.
 */
function deduplicateNames(names: string[]): string[] {
    const nextEntryName = createNameDeduplicator();
    return names.map((name) => nextEntryName(name));
}

/**
 * Create a zip blob from file slices
 * Uses STORE compression (no compression) to reduce memory usage for large files
 */
export async function createZipFromFiles(fileSlices: FileSlice[]): Promise<Blob> {
    const zip = new JSZip();

    // Sanitize + de-duplicate entry names before they reach the archive headers
    const dedupedSlices = deduplicateFilenames(fileSlices);

    // JSZip 3.x cannot emit ZIP64, so anything at or past 4 GiB would be
    // written with wrapped sizes/offsets and no error. Fail here, before the
    // caller reports the download complete, so the credit isn't burned.
    assertZipFitsWithoutZip64(
        dedupedSlices.map((slice) => ({ name: slice.name, size: entryByteLength(slice.data) })),
    );

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
    } catch (error: unknown) {
        // If blob creation fails due to memory, throw a more helpful error
        if (error instanceof Error && error.message?.includes("can't construct the Blob")) {
            throw new Error('Download too large for browser. Try downloading fewer files at once.');
        }
        throw error;
    }
}

/**
 * Flatten a derived archive filename to a single, separator-free path segment.
 *
 * The archive's own name is derived from the same uploader-controlled metadata
 * as the entry names, and it ends up in a `download` attribute / Save dialog.
 * Browsers do neutralize separators there, but deriving a clean name costs
 * nothing and keeps the guarantee local to this module.
 */
function sanitizeArchiveBaseName(baseName: string): string {
    const flattened = stripControlCharacters(baseName)
        .replace(/[\\/]+/g, '_')
        .trim();
    // A base made only of separators or whitespace carries no information
    return flattened.replace(/^_+|_+$/g, '') === '' ? 'download' : flattened;
}

/**
 * Split a stream into consecutive fixed-length sub-streams.
 *
 * The sub-streams MUST be consumed strictly in order — they all pull from one
 * underlying reader — which is exactly how `client-zip` consumes its entries.
 */
function createSequentialSplitter(source: ReadableStream<Uint8Array>) {
    // Acquired lazily so the caller can still cancel `source` outright if it
    // decides not to consume the zip at all (e.g. no save target could be
    // opened) — `getReader()` locks the stream against that.
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const getReader = () => {
        if (!reader) {
            reader = source.getReader();
        }
        return reader;
    };
    let leftover: Uint8Array | null = null;
    let exhausted = false;

    /** Up to `limit` bytes, or null once the source is drained. */
    const readUpTo = async (limit: number): Promise<Uint8Array | null> => {
        if (leftover) {
            const take = Math.min(limit, leftover.length);
            const out = leftover.subarray(0, take);
            leftover = take < leftover.length ? leftover.subarray(take) : null;
            return out;
        }
        while (!exhausted) {
            const { done, value } = await getReader().read();
            if (done) {
                exhausted = true;
                break;
            }
            // WebKit can emit empty chunks mid-stream; they are not EOF.
            if (!value || value.length === 0) {
                continue;
            }
            if (value.length <= limit) {
                return value;
            }
            leftover = value.subarray(limit);
            return value.subarray(0, limit);
        }
        return null;
    };

    return {
        /**
         * A stream of the next `size` bytes. Closes early if the source runs
         * out first, so a payload shorter than its metadata truncates the
         * trailing entries instead of hanging.
         */
        take(size: number): ReadableStream<Uint8Array> {
            let remaining = size;
            return new ReadableStream<Uint8Array>({
                async pull(controller) {
                    if (remaining <= 0) {
                        controller.close();
                        return;
                    }
                    const chunk = await readUpTo(remaining);
                    if (!chunk) {
                        controller.close();
                        return;
                    }
                    remaining -= chunk.length;
                    controller.enqueue(chunk);
                    if (remaining <= 0) {
                        controller.close();
                    }
                },
            });
        },
        /**
         * Read and discard anything past the last entry.
         *
         * Metadata can under-count the payload as easily as over-count it, and
         * the caller checks the received byte count against `Content-Length`.
         * Cancelling here instead would make that check see a short read and
         * fail a download that is merely carrying a few drifted bytes.
         */
        async drain(): Promise<void> {
            leftover = null;
            while (!exhausted) {
                const { done } = await getReader().read();
                if (done) {
                    exhausted = true;
                }
            }
        },
        /** Abandon the source outright; for when the consumer has gone away. */
        async release(): Promise<void> {
            leftover = null;
            try {
                await (reader ? reader.cancel() : source.cancel());
            } catch {
                // Already closed or errored — nothing to release.
            }
        },
    };
}

/**
 * Build a zip from a concatenated payload stream without ever materializing it.
 *
 * A legacy (not-zipped-at-upload) multi-file payload is `file[0] || file[1] ||
 * …` in metadata order, so it can be split sequentially by size — no random
 * access, and therefore no need to hold the payload in a Blob first. Entries go
 * straight into client-zip (STORE, ZIP64-correct) so the archive is produced
 * incrementally and can be piped to a `DownloadWriter`.
 *
 * Legacy metadata sizes can drift from the real payload (iOS lazily transcodes
 * HEIC/HEVC after `File.size` is read), so this is deliberately non-strict:
 * entries are truncated to whatever the payload actually holds. `size` is not
 * declared to client-zip, which writes the true byte count and CRC of each
 * entry into its data descriptor, so a drifted payload still yields a valid zip.
 */
export function createZipStreamFromConcatenated(
    payload: ReadableStream<Uint8Array>,
    files: FileInfo[],
): { stream: ReadableStream<Uint8Array>; estimatedSize: number } {
    const splitter = createSequentialSplitter(payload);
    // client-zip rejects empty names outright; legacy metadata is uploader-controlled.
    const names = deduplicateNames(files.map((f, i) => f.name || `file-${i + 1}`));

    async function* entries() {
        let abandoned = false;
        try {
            for (let i = 0; i < files.length; i++) {
                yield { name: names[i], input: splitter.take(files[i].size) };
            }
        } catch {
            // client-zip cancels by throwing into this generator when the zip
            // stream's consumer goes away. Swallow it — an unhandled rejection
            // is the only thing propagating it would achieve.
            abandoned = true;
        } finally {
            await (abandoned ? splitter.release() : splitter.drain());
        }
    }

    // Best-effort hint for the save-target size gate; exact when metadata sizes
    // match the payload, which is the normal case.
    const estimatedSize = Number(
        predictLength(files.map((f, i) => ({ name: names[i], size: f.size }))),
    );

    return { stream: makeZip(entries()), estimatedSize };
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
        return `${sanitizeArchiveBaseName(baseName)}.zip`;
    }

    // Find common prefix among filenames
    const names = files.map((f) => f.name);
    const commonPrefix = findCommonPrefix(names);

    if (commonPrefix.length >= 3) {
        // Use common prefix if it's meaningful (at least 3 chars)
        return `${sanitizeArchiveBaseName(commonPrefix.replace(/[_\-\s]+$/, ''))}.zip`;
    }

    // Otherwise use generic name with file count
    return `files-${files.length}.zip`;
}

/**
 * Find common prefix among an array of strings
 */
function findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) {
        return '';
    }
    if (strings.length === 1) {
        return strings[0];
    }

    let prefix = '';
    const first = strings[0];

    for (let i = 0; i < first.length; i++) {
        const char = first[i];
        if (strings.every((s) => s[i] === char)) {
            prefix += char;
        } else {
            break;
        }
    }

    return prefix;
}
