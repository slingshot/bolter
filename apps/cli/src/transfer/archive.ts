/**
 * A ZIP archive as a *layout*, not a stream.
 *
 * Every offset is computed up front from the entry list alone — names, sizes,
 * and nothing else. That makes the archive a virtual file: given any byte
 * range, we can say exactly which header or which slice of which source file
 * produces it, without having read a single byte of content.
 *
 * That is the whole reason directory uploads are resumable here and are not in
 * the browser, where "zip production cannot restart mid-archive". It is also
 * why the archive is *stored* rather than deflated: a compressed entry's size
 * is unknowable until it has been compressed, and an archive whose layout
 * depends on its contents cannot be seeked. `--compress` opts into a real
 * DEFLATE archive by materialising it to a temp file first.
 *
 * Zip64 is used unconditionally for sizes and offsets that need it, because a
 * CLI whose stated purpose is 1 TB transfers will exceed every 32-bit field in
 * the original format.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIGNATURE = 0x06054b50;

const LOCAL_HEADER_BASE = 30;
const CENTRAL_HEADER_BASE = 46;
const EOCD_BASE = 22;
const ZIP64_EOCD_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;

/** Store (no compression). The only method whose size is known in advance. */
const METHOD_STORE = 0;

/** Version 4.5 — the first that specifies zip64. */
const VERSION_ZIP64 = 45;

/**
 * Bit 11: names are UTF-8. Without it a reader may interpret names as CP437,
 * which mangles every non-ASCII filename.
 */
const FLAG_UTF8 = 0x800;

/**
 * Bit 3: sizes and CRC follow the data in a descriptor rather than preceding
 * it in the local header.
 *
 * Needed because CRC-32 is a function of content, and the local header is
 * written *before* the content it describes. The alternative is reading every
 * file twice — once to checksum, once to upload — which for the terabyte
 * directories this CLI exists to move is an extra terabyte of reads.
 *
 * Crucially this costs nothing in determinism: a descriptor is a fixed size,
 * so the layout is still computable from names and sizes alone.
 */
const FLAG_DATA_DESCRIPTOR = 0x008;

const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
/** signature + crc + two 4-byte sizes. */
const DATA_DESCRIPTOR_SIZE = 16;
/** signature + crc + two 8-byte sizes. */
const DATA_DESCRIPTOR_SIZE_ZIP64 = 24;

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

export interface ArchiveInput {
    /** Path stored in the archive. Always forward slashes, never absolute. */
    name: string;
    size: number;
    /** Source path on disk. */
    path: string;
    /** Modification time, for the DOS timestamp fields. */
    mtime: Date;
}

export interface ArchiveEntry extends ArchiveInput {
    /**
     * Filled in as the entry's content streams past. Zero until then — which
     * is safe because every place it is written (the data descriptor and the
     * central directory) comes after the content in the layout.
     */
    crc32: number;
    /** Offset of this entry's local header in the archive. */
    headerOffset: number;
    /** Offset of this entry's first content byte. */
    dataOffset: number;
    /** Offset of the data descriptor that follows the content. */
    descriptorOffset: number;
    descriptorSize: number;
    nameBytes: Uint8Array;
    /** True when this entry needs zip64 fields in its headers. */
    zip64: boolean;
}

export interface ArchiveLayout {
    entries: ArchiveEntry[];
    /** Offset where the central directory begins. */
    centralDirectoryOffset: number;
    centralDirectorySize: number;
    totalSize: number;
    zip64: boolean;
}

/**
 * CRC-32 is required by the format, and it is a function of file *content* —
 * the one part of the layout that cannot be derived from metadata.
 *
 * Rather than read every file up front (which would defeat the point), entries
 * are laid out with a placeholder and the real value is filled in as content
 * streams past. That works because the CRC lives in the central directory at
 * the *end* of the archive, which is produced last — by the time those bytes
 * are needed, every file has been read.
 *
 * The local header also carries a CRC. It is written as the same value, so a
 * range covering a local header must not be produced before that file's
 * content has been seen. In practice parts are produced in order, and
 * `crcKnown` makes the violation loud rather than silent.
 */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
    let c = (seed ^ -1) >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    }
    return (c ^ -1) >>> 0;
}

/** DOS date/time, which the format still uses. Clamped to its 1980 epoch. */
export function dosDateTime(date: Date): { time: number; date: number } {
    const year = Math.max(1980, date.getFullYear());
    return {
        time:
            (Math.floor(date.getSeconds() / 2) & 0x1f) |
            ((date.getMinutes() & 0x3f) << 5) |
            ((date.getHours() & 0x1f) << 11),
        date:
            (date.getDate() & 0x1f) |
            (((date.getMonth() + 1) & 0x0f) << 5) |
            (((year - 1980) & 0x7f) << 9),
    };
}

const encoder = new TextEncoder();

/** Local header extra field: zip64 sizes are 20 bytes (header + 2 x u64). */
const ZIP64_LOCAL_EXTRA = 20;
/** Central header extra: sizes plus the header offset. */
const ZIP64_CENTRAL_EXTRA = 28;

function needsZip64(entry: ArchiveInput, headerOffset: number): boolean {
    return entry.size > U32_MAX || headerOffset > U32_MAX;
}

/**
 * Compute every offset in the archive from the entry list alone.
 *
 * Deterministic: the same inputs always produce the same layout, which is what
 * lets an interrupted upload resume without re-deriving anything.
 */
export function planArchive(inputs: ArchiveInput[]): ArchiveLayout {
    const entries: ArchiveEntry[] = [];
    let offset = 0;

    for (const input of inputs) {
        const nameBytes = encoder.encode(input.name);
        const zip64 = needsZip64(input, offset);
        const headerOffset = offset;
        const dataOffset =
            headerOffset + LOCAL_HEADER_BASE + nameBytes.length + (zip64 ? ZIP64_LOCAL_EXTRA : 0);
        const descriptorOffset = dataOffset + input.size;
        const descriptorSize = zip64 ? DATA_DESCRIPTOR_SIZE_ZIP64 : DATA_DESCRIPTOR_SIZE;
        entries.push({
            ...input,
            crc32: 0,
            headerOffset,
            dataOffset,
            descriptorOffset,
            descriptorSize,
            nameBytes,
            zip64,
        });
        offset = descriptorOffset + descriptorSize;
    }

    const centralDirectoryOffset = offset;
    let centralDirectorySize = 0;
    for (const entry of entries) {
        centralDirectorySize +=
            CENTRAL_HEADER_BASE + entry.nameBytes.length + (entry.zip64 ? ZIP64_CENTRAL_EXTRA : 0);
    }

    // Zip64 end-of-central-directory is required once any count, size or offset
    // exceeds its 32-bit field. Emitting it early is harmless; omitting it when
    // needed produces an archive that silently truncates.
    const zip64 =
        entries.length > U16_MAX ||
        centralDirectoryOffset > U32_MAX ||
        centralDirectorySize > U32_MAX ||
        entries.some((e) => e.zip64);

    const totalSize =
        centralDirectoryOffset +
        centralDirectorySize +
        (zip64 ? ZIP64_EOCD_SIZE + ZIP64_LOCATOR_SIZE : 0) +
        EOCD_BASE;

    return { entries, centralDirectoryOffset, centralDirectorySize, totalSize, zip64 };
}

function u16(view: DataView, at: number, value: number): void {
    view.setUint16(at, value, true);
}
function u32(view: DataView, at: number, value: number): void {
    view.setUint32(at, value >>> 0, true);
}
function u64(view: DataView, at: number, value: number): void {
    view.setBigUint64(at, BigInt(value), true);
}

export function localHeaderBytes(entry: ArchiveEntry): Uint8Array {
    const extra = entry.zip64 ? ZIP64_LOCAL_EXTRA : 0;
    const bytes = new Uint8Array(LOCAL_HEADER_BASE + entry.nameBytes.length + extra);
    const view = new DataView(bytes.buffer);
    const { time, date } = dosDateTime(entry.mtime);

    u32(view, 0, LOCAL_HEADER_SIGNATURE);
    u16(view, 4, entry.zip64 ? VERSION_ZIP64 : 20);
    u16(view, 6, FLAG_UTF8 | FLAG_DATA_DESCRIPTOR);
    u16(view, 8, METHOD_STORE);
    u16(view, 10, time);
    u16(view, 12, date);
    // CRC and sizes are zero here and carried in the trailing descriptor; that
    // is exactly what bit 3 means. Sizes still appear in the zip64 extra field
    // below, because the field is fixed-width and readers expect it present.
    u32(view, 14, 0);
    u32(view, 18, 0);
    u32(view, 22, 0);
    u16(view, 26, entry.nameBytes.length);
    u16(view, 28, extra);
    bytes.set(entry.nameBytes, LOCAL_HEADER_BASE);

    if (entry.zip64) {
        const at = LOCAL_HEADER_BASE + entry.nameBytes.length;
        u16(view, at, 0x0001);
        u16(view, at + 2, 16);
        u64(view, at + 4, entry.size);
        u64(view, at + 12, entry.size);
    }
    return bytes;
}

export function centralHeaderBytes(entry: ArchiveEntry): Uint8Array {
    const extra = entry.zip64 ? ZIP64_CENTRAL_EXTRA : 0;
    const bytes = new Uint8Array(CENTRAL_HEADER_BASE + entry.nameBytes.length + extra);
    const view = new DataView(bytes.buffer);
    const { time, date } = dosDateTime(entry.mtime);

    u32(view, 0, CENTRAL_HEADER_SIGNATURE);
    // Version made by: 3 (Unix) << 8 | version needed.
    u16(view, 4, (3 << 8) | (entry.zip64 ? VERSION_ZIP64 : 20));
    u16(view, 6, entry.zip64 ? VERSION_ZIP64 : 20);
    u16(view, 8, FLAG_UTF8 | FLAG_DATA_DESCRIPTOR);
    u16(view, 10, METHOD_STORE);
    u16(view, 12, time);
    u16(view, 14, date);
    u32(view, 16, entry.crc32);
    u32(view, 20, entry.zip64 ? U32_MAX : entry.size);
    u32(view, 24, entry.zip64 ? U32_MAX : entry.size);
    u16(view, 28, entry.nameBytes.length);
    u16(view, 30, extra);
    u16(view, 32, 0); // comment length
    u16(view, 34, 0); // disk number
    u16(view, 36, 0); // internal attributes
    // External attributes: 0644 regular file, in the high 16 bits.
    u32(view, 38, 0o100644 << 16);
    u32(view, 42, entry.zip64 ? U32_MAX : entry.headerOffset);
    bytes.set(entry.nameBytes, CENTRAL_HEADER_BASE);

    if (entry.zip64) {
        const at = CENTRAL_HEADER_BASE + entry.nameBytes.length;
        u16(view, at, 0x0001);
        u16(view, at + 2, 24);
        u64(view, at + 4, entry.size);
        u64(view, at + 12, entry.size);
        u64(view, at + 20, entry.headerOffset);
    }
    return bytes;
}

/**
 * The descriptor that follows an entry's content, carrying the CRC and sizes
 * the local header could not know.
 */
export function dataDescriptorBytes(entry: ArchiveEntry): Uint8Array {
    const bytes = new Uint8Array(entry.descriptorSize);
    const view = new DataView(bytes.buffer);
    u32(view, 0, DATA_DESCRIPTOR_SIGNATURE);
    u32(view, 4, entry.crc32);
    if (entry.zip64) {
        u64(view, 8, entry.size);
        u64(view, 16, entry.size);
    } else {
        u32(view, 8, entry.size);
        u32(view, 12, entry.size);
    }
    return bytes;
}

export function endOfCentralDirectoryBytes(layout: ArchiveLayout): Uint8Array {
    const count = layout.entries.length;
    const size = layout.zip64 ? ZIP64_EOCD_SIZE + ZIP64_LOCATOR_SIZE + EOCD_BASE : EOCD_BASE;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;

    if (layout.zip64) {
        u32(view, at, ZIP64_EOCD_SIGNATURE);
        u64(view, at + 4, ZIP64_EOCD_SIZE - 12); // size of this record minus 12
        u16(view, at + 12, (3 << 8) | VERSION_ZIP64);
        u16(view, at + 14, VERSION_ZIP64);
        u32(view, at + 16, 0);
        u32(view, at + 20, 0);
        u64(view, at + 24, count);
        u64(view, at + 32, count);
        u64(view, at + 40, layout.centralDirectorySize);
        u64(view, at + 48, layout.centralDirectoryOffset);
        at += ZIP64_EOCD_SIZE;

        u32(view, at, ZIP64_LOCATOR_SIGNATURE);
        u32(view, at + 4, 0);
        u64(view, at + 8, layout.centralDirectoryOffset + layout.centralDirectorySize);
        u32(view, at + 16, 1);
        at += ZIP64_LOCATOR_SIZE;
    }

    u32(view, at, EOCD_SIGNATURE);
    u16(view, at + 4, 0);
    u16(view, at + 6, 0);
    u16(view, at + 8, layout.zip64 ? U16_MAX : count);
    u16(view, at + 10, layout.zip64 ? U16_MAX : count);
    u32(view, at + 12, layout.zip64 ? U32_MAX : layout.centralDirectorySize);
    u32(view, at + 16, layout.zip64 ? U32_MAX : layout.centralDirectoryOffset);
    u16(view, at + 20, 0);
    return bytes;
}

/**
 * Normalise a path for storage in the archive.
 *
 * Absolute paths and `..` segments are stripped: an archive that unpacks
 * outside its destination is the Zip Slip vulnerability, and producing one is
 * as much a bug as accepting one.
 */
export function archiveName(relativePath: string): string {
    return relativePath
        .split(/[\\/]+/)
        .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
        .join('/');
}
