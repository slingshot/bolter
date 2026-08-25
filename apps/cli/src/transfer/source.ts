/**
 * What the uploader reads from.
 *
 * A source answers one question — "give me bytes `[start, end)` of the payload"
 * — and it must answer it identically every time, because a retried part
 * re-reads the exact same range and S3 will happily assemble an object from
 * parts that disagree.
 *
 * That property is why nothing here is a stream over the payload. A stream has
 * a position; a source has an address space.
 */

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { MetadataFileEntry } from '@bolter/protocol';
import { SendfmError } from '../core/errors';
import {
    type ArchiveEntry,
    type ArchiveInput,
    type ArchiveLayout,
    archiveName,
    centralHeaderBytes,
    crc32,
    dataDescriptorBytes,
    endOfCentralDirectoryBytes,
    localHeaderBytes,
    planArchive,
} from './archive';

export interface Source {
    /** Size of the payload before any encryption. */
    readonly plaintextSize: number;
    /** What to call this in the UI. */
    readonly displayName: string;
    /** Entries for the share's metadata blob. */
    readonly files: MetadataFileEntry[];
    /** Set when the payload is an archive built from several inputs. */
    readonly archiveFilename?: string;
    read(start: number, end: number): AsyncIterable<Uint8Array>;
    close(): Promise<void>;
}

/** A single file on disk. The simplest and by far the most common case. */
export class FileSource implements Source {
    readonly plaintextSize: number;
    readonly displayName: string;
    readonly files: MetadataFileEntry[];
    /** Declared so the absence is part of the type: a lone file is never an archive. */
    readonly archiveFilename: undefined = undefined;

    constructor(
        private readonly path: string,
        size: number,
        type: string,
    ) {
        this.plaintextSize = size;
        this.displayName = basename(path);
        this.files = [{ name: this.displayName, size, type }];
    }

    static async open(path: string): Promise<FileSource> {
        const info = await stat(path).catch(() => null);
        if (!info || !info.isFile()) {
            throw new SendfmError('FILE_NOT_FOUND', `Not a readable file: ${path}`);
        }
        const type = Bun.file(path).type || 'application/octet-stream';
        return new FileSource(path, info.size, type);
    }

    async *read(start: number, end: number): AsyncIterable<Uint8Array> {
        // A BunFile slice is a lazy view: it opens at the offset rather than
        // reading forward to it, so producing part 7,000 costs the same as
        // producing part 1.
        const reader = Bun.file(this.path).slice(start, end).stream().getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            yield value;
        }
    }

    close(): Promise<void> {
        return Promise.resolve();
    }
}

/**
 * A snapshot of checksum progress at an archive offset.
 *
 * Needed because a retried part re-reads a range that has already contributed
 * to a CRC. Without the ability to rewind, the second read would fold the same
 * bytes in twice and the archive's checksums would be wrong — silently, since
 * the upload itself would succeed.
 */
interface CrcCheckpoint {
    /** Finished CRC per entry, by index. */
    crcs: number[];
    /** Index of the entry currently being checksummed, if any. */
    activeEntry: number;
    /** Running CRC seed for that entry. */
    activeSeed: number;
}

export class ArchiveSource implements Source {
    readonly plaintextSize: number;
    readonly displayName: string;
    readonly files: MetadataFileEntry[];
    readonly archiveFilename: string;

    private readonly layout: ArchiveLayout;
    /** Checkpoints by archive offset, so any produced boundary can be resumed. */
    private readonly checkpoints = new Map<number, CrcCheckpoint>();
    private state: CrcCheckpoint;

    private constructor(
        layout: ArchiveLayout,
        archiveFilename: string,
        files: MetadataFileEntry[],
    ) {
        this.layout = layout;
        this.archiveFilename = archiveFilename;
        this.displayName = archiveFilename;
        this.files = files;
        this.plaintextSize = layout.totalSize;
        this.state = { crcs: layout.entries.map(() => 0), activeEntry: -1, activeSeed: 0 };
        this.checkpoints.set(0, structuredClone(this.state));
    }

    static async open(inputs: Array<{ path: string; name: string }>): Promise<ArchiveSource> {
        const archiveInputs: ArchiveInput[] = [];
        const files: MetadataFileEntry[] = [];
        for (const input of inputs) {
            const info = await stat(input.path).catch(() => null);
            if (!info || !info.isFile()) {
                throw new SendfmError('FILE_NOT_FOUND', `Not a readable file: ${input.path}`);
            }
            const name = archiveName(input.name);
            if (!name) {
                throw new SendfmError('USAGE', `Cannot store "${input.name}" in an archive`);
            }
            archiveInputs.push({ name, size: info.size, path: input.path, mtime: info.mtime });
            files.push({
                name,
                size: info.size,
                type: Bun.file(input.path).type || 'application/octet-stream',
            });
        }
        const layout = planArchive(archiveInputs);
        return new ArchiveSource(layout, suggestArchiveName(files), files);
    }

    /** Total size is known before a byte is read — that is the point. */
    get totalSize(): number {
        return this.layout.totalSize;
    }

    private restore(offset: number): void {
        const checkpoint = this.checkpoints.get(offset);
        if (!checkpoint) {
            throw new SendfmError(
                'INTERNAL',
                `Archive range must start at a produced boundary; ${offset} is not one`,
                {
                    hint: 'This is a bug — archive parts are produced in order.',
                },
            );
        }
        this.state = structuredClone(checkpoint);
    }

    async *read(start: number, end: number): AsyncIterable<Uint8Array> {
        this.restore(start);
        let at = start;

        while (at < end) {
            const chunk = await this.chunkAt(at, end);
            at += chunk.length;
            if (chunk.length === 0) {
                throw new SendfmError('INTERNAL', `Archive layout stalled at offset ${at}`);
            }
            yield chunk;
        }

        this.checkpoints.set(end, structuredClone(this.state));
    }

    /** Produce the next contiguous run of bytes starting at `at`. */
    private async chunkAt(at: number, limit: number): Promise<Uint8Array> {
        const { entries } = this.layout;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (at < entry.dataOffset) {
                return slice(localHeaderBytes(entry), at - entry.headerOffset, limit - at);
            }
            if (at < entry.descriptorOffset) {
                return await this.readContent(entry, i, at, limit);
            }
            if (at < entry.descriptorOffset + entry.descriptorSize) {
                // Every byte of this entry has now been read, so its CRC is final.
                const finished = { ...entry, crc32: this.state.crcs[i] };
                return slice(
                    dataDescriptorBytes(finished),
                    at - entry.descriptorOffset,
                    limit - at,
                );
            }
        }

        if (at < this.layout.centralDirectoryOffset + this.layout.centralDirectorySize) {
            return this.readCentralDirectory(at, limit);
        }
        const trailerStart = this.layout.centralDirectoryOffset + this.layout.centralDirectorySize;
        return slice(endOfCentralDirectoryBytes(this.layout), at - trailerStart, limit - at);
    }

    private async readContent(
        entry: ArchiveEntry,
        index: number,
        at: number,
        limit: number,
    ): Promise<Uint8Array> {
        if (this.state.activeEntry !== index) {
            this.state.activeEntry = index;
            this.state.activeSeed = 0;
        }
        const from = at - entry.dataOffset;
        const to = Math.min(entry.size, from + (limit - at));
        const bytes = new Uint8Array(await Bun.file(entry.path).slice(from, to).arrayBuffer());
        if (bytes.length !== to - from) {
            // The file changed under us. Continuing would upload an archive
            // whose headers describe a file that no longer exists.
            throw new SendfmError(
                'LOCAL_STATE',
                `${entry.name} changed while it was being uploaded`,
                { hint: 'Re-run the upload once the file has stopped changing.' },
            );
        }
        this.state.activeSeed = crc32(bytes, this.state.activeSeed);
        this.state.crcs[index] = this.state.activeSeed;
        return bytes;
    }

    private readCentralDirectory(at: number, limit: number): Uint8Array {
        // Assembled with the CRCs computed while the content streamed past.
        // Safe because the central directory is the last thing in the archive.
        let cursor = this.layout.centralDirectoryOffset;
        for (let i = 0; i < this.layout.entries.length; i++) {
            const header = centralHeaderBytes({
                ...this.layout.entries[i],
                crc32: this.state.crcs[i],
            });
            if (at < cursor + header.length) {
                return slice(header, at - cursor, limit - at);
            }
            cursor += header.length;
        }
        throw new SendfmError('INTERNAL', `Central directory offset ${at} out of range`);
    }

    close(): Promise<void> {
        return Promise.resolve();
    }
}

function slice(bytes: Uint8Array, from: number, maxLength: number): Uint8Array {
    return bytes.subarray(from, Math.min(bytes.length, from + maxLength));
}

/**
 * Name an archive after what is in it: a shared prefix if there is a
 * meaningful one, otherwise the count. Mirrors the web app's
 * `generateZipFilename` so the two produce recognisably similar names.
 */
export function suggestArchiveName(files: MetadataFileEntry[]): string {
    if (files.length === 0) {
        return 'download.zip';
    }
    if (files.length === 1) {
        const name = files[0].name;
        const dot = name.lastIndexOf('.');
        return `${dot > 0 ? name.slice(0, dot) : name}.zip`;
    }
    const prefix = commonPrefix(files.map((f) => f.name));
    const trimmed = prefix.replace(/[_\-\s/]+$/, '');
    return trimmed.length >= 3 ? `${trimmed}.zip` : `files-${files.length}.zip`;
}

function commonPrefix(values: string[]): string {
    if (values.length === 0) {
        return '';
    }
    let prefix = values[0];
    for (const value of values.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < value.length && prefix[i] === value[i]) {
            i++;
        }
        prefix = prefix.slice(0, i);
        if (!prefix) {
            return '';
        }
    }
    return prefix;
}
