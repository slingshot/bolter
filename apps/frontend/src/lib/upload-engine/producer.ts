/**
 * Byte producers for the worker upload engine.
 *
 * All reads are slice-based (`Blob.slice().arrayBuffer()`) — `file.stream()`
 * is retired inside the engine. Slices are cheap offset views, so a resumed
 * producer restarts from an exact byte offset, and reads happen in bounded,
 * record-aligned chunks: `createEncryptionStream` re-slices its remaining
 * buffer once per 64 KiB record, so part-sized input chunks would cause
 * near-quadratic copying [R2].
 *
 * Worker-safe: no DOM globals. The zip producer runs client-zip in the worker
 * via `createStreamingZip`'s injected `streamFactory` (Task 2), so even
 * multi-file archives are fed from slice-backed streams.
 */

import { ECE_RECORD_SIZE } from '@bolter/protocol/crypto';
import { createStreamingZip } from '@/lib/zip';

export const PRODUCER_CHUNK_RECORDS = 64; // 64 × 65,536 = 4 MiB plaintext per read

const DEFAULT_CHUNK_BYTES = PRODUCER_CHUNK_RECORDS * ECE_RECORD_SIZE;

export interface ProducerChunk {
    bytes: Uint8Array;
    sourceOffset: number; // offset BEFORE this chunk
}

/**
 * Sequential slice reader over a Blob/File. Yields non-empty chunks only;
 * EOF is a short read.
 *
 * Growth probe [R1]: on iOS, files picked via `<input>` may be lazily
 * transcoded (HEIC→JPEG, HEVC→H.264), so the declared `size` can be stale
 * while `slice()` sees the real bytes. A short read that lands exactly on the
 * declared size is therefore ambiguous — the producer probes one further
 * slice past the declared size and, if bytes come back, keeps reading until a
 * genuine short read. A read that returns nothing is always definitive EOF.
 */
export async function* createSliceProducer(
    source: Blob,
    opts?: { startOffset?: number; chunkBytes?: number },
): AsyncGenerator<ProducerChunk> {
    const chunkBytes = opts?.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
        throw new Error(`chunkBytes must be a positive integer, got ${chunkBytes}`);
    }
    const declaredSize = source.size;
    let offset = opts?.startOffset ?? 0;
    while (true) {
        const bytes = new Uint8Array(await source.slice(offset, offset + chunkBytes).arrayBuffer());
        if (bytes.byteLength === 0) {
            return; // asked and got nothing — definitive EOF
        }
        yield { bytes, sourceOffset: offset };
        offset += bytes.byteLength;
        if (bytes.byteLength === chunkBytes) {
            continue; // full read — more may follow
        }
        if (offset === declaredSize) {
            continue; // short read at exactly the declared size — growth probe [R1]
        }
        return; // short read past/before the declared size — EOF
    }
}

/**
 * Zip producer: streams a client-zip archive of `files` (stored under
 * `names`) as record-aligned chunks. Entry bytes are pulled with the same
 * slice loop as `createSliceProducer` — never `file.stream()`.
 *
 * NOT restartable mid-stream — zip resume is crash-window only: staged parts
 * survive a reload, but production cannot re-wind into a half-written
 * archive.
 */
export async function* createZipProducer(
    files: File[],
    names: string[],
    opts?: { chunkBytes?: number },
): AsyncGenerator<ProducerChunk> {
    const chunkBytes = opts?.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    // createStreamingZip derives entry names from `File.name`; wrap only when
    // the caller-assigned name differs (a File constructed over an existing
    // one references the same bytes — no copy).
    const sources = files.map((file, index) => {
        const name = names[index];
        if (name === undefined || name === file.name) {
            return file;
        }
        return new File([file], name, { type: file.type, lastModified: file.lastModified });
    });
    const zip = createStreamingZip(sources, undefined, {
        streamFactory: (file) => sliceBackedStream(file, chunkBytes),
    });
    const reader = zip.stream.getReader();
    try {
        let sourceOffset = 0;
        const queue: Uint8Array[] = [];
        let queuedBytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value || value.byteLength === 0) {
                continue; // WebKit streams can emit empty chunks — filter them
            }
            queue.push(value);
            queuedBytes += value.byteLength;
            while (queuedBytes >= chunkBytes) {
                const bytes = drainExact(queue, chunkBytes);
                queuedBytes -= chunkBytes;
                yield { bytes, sourceOffset };
                sourceOffset += bytes.byteLength;
            }
        }
        if (queuedBytes > 0) {
            yield { bytes: drainExact(queue, queuedBytes), sourceOffset };
        }
    } finally {
        // Runs on normal completion and when the consumer stops early
        // (cancel): release the output stream, then let dispose() cancel the
        // per-file sources — it is idempotent and never rejects.
        reader.releaseLock();
        await zip.dispose();
    }
}

/** Adapt the slice loop to the ReadableStream `createStreamingZip` expects. */
function sliceBackedStream(source: Blob, chunkBytes: number): ReadableStream<Uint8Array> {
    const producer = createSliceProducer(source, { chunkBytes });
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await producer.next();
            if (done) {
                controller.close();
                return;
            }
            controller.enqueue(value.bytes);
        },
        async cancel() {
            await producer.return(undefined);
        },
    });
}

/**
 * Take exactly `want` bytes off the front of `queue` (the caller guarantees
 * they are available), splitting the boundary chunk if needed.
 */
function drainExact(queue: Uint8Array[], want: number): Uint8Array {
    const out = new Uint8Array(want);
    let filled = 0;
    while (filled < want) {
        const head = queue[0];
        const take = Math.min(head.byteLength, want - filled);
        out.set(head.subarray(0, take), filled);
        if (take === head.byteLength) {
            queue.shift();
        } else {
            queue[0] = head.subarray(take);
        }
        filled += take;
    }
    return out;
}
