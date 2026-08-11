import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createStreamingZip } from '@/lib/zip';
import { createSliceProducer, createZipProducer, type ProducerChunk } from '../producer';

async function collect(producer: AsyncGenerator<ProducerChunk>): Promise<ProducerChunk[]> {
    const chunks: ProducerChunk[] = [];
    for await (const chunk of producer) {
        chunks.push(chunk);
    }
    return chunks;
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    return concat(chunks);
}

const TEN_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/**
 * Simulates iOS lazy transcoding: the declared `size` is stale, reads within
 * the declared range are clamped to it, but the real backing store has more
 * bytes that only reads past the declared size can see.
 */
function transcodingSource(backing: Uint8Array, declaredSize: number): Blob {
    const fake = {
        size: declaredSize,
        slice(start: number, end: number): Blob {
            const clampedEnd = start < declaredSize ? Math.min(end, declaredSize) : end;
            return new Blob([backing.subarray(start, clampedEnd) as BlobPart]);
        },
    };
    return fake as unknown as Blob;
}

describe('createSliceProducer', () => {
    it('chunks a source at chunkBytes boundaries with correct offsets', async () => {
        const chunks = await collect(createSliceProducer(new Blob([TEN_BYTES]), { chunkBytes: 4 }));
        expect(chunks.map((c) => c.bytes.byteLength)).toEqual([4, 4, 2]);
        expect(chunks.map((c) => c.sourceOffset)).toEqual([0, 4, 8]);
        expect(concat(chunks.map((c) => c.bytes))).toEqual(TEN_BYTES);
    });

    it('yields nothing for an empty source', async () => {
        const chunks = await collect(createSliceProducer(new Blob([]), { chunkBytes: 4 }));
        expect(chunks).toEqual([]);
    });

    it('resumes exactly from startOffset', async () => {
        const chunks = await collect(
            createSliceProducer(new Blob([TEN_BYTES]), { startOffset: 4, chunkBytes: 4 }),
        );
        expect(chunks.map((c) => c.bytes.byteLength)).toEqual([4, 2]);
        expect(chunks.map((c) => c.sourceOffset)).toEqual([4, 8]);
        expect(concat(chunks.map((c) => c.bytes))).toEqual(TEN_BYTES.subarray(4));
    });

    it('probes past the declared size and drains growth to a short read', async () => {
        const backing = new Uint8Array(14).map((_, i) => i + 1);
        const chunks = await collect(
            createSliceProducer(transcodingSource(backing, 10), { chunkBytes: 8 }),
        );
        // 8 (full) → 2 (clamped short read landing exactly at declared size,
        // so the producer probes past it) → 4 (growth, then true EOF).
        expect(chunks.map((c) => c.bytes.byteLength)).toEqual([8, 2, 4]);
        expect(chunks.map((c) => c.sourceOffset)).toEqual([0, 8, 10]);
        expect(concat(chunks.map((c) => c.bytes))).toEqual(backing);
    });
});

describe('createZipProducer', () => {
    it('yields only non-empty chunks for a zero-byte file', async () => {
        const file = new File([], 'empty.bin', { lastModified: 1_700_000_000_000 });
        const chunks = await collect(createZipProducer([file], ['empty.bin']));
        expect(chunks.length).toBeGreaterThan(0); // zip headers exist
        for (const chunk of chunks) {
            expect(chunk.bytes.byteLength).toBeGreaterThan(0);
        }
    });

    it('produces bytes identical to createStreamingZip', async () => {
        const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'a.bin', {
            type: 'application/octet-stream',
            lastModified: 1_700_000_000_000,
        });
        const chunks = await collect(createZipProducer([file], ['a.bin'], { chunkBytes: 7 }));
        let expectedOffset = 0;
        for (const chunk of chunks) {
            expect(chunk.bytes.byteLength).toBeGreaterThan(0);
            expect(chunk.sourceOffset).toBe(expectedOffset);
            expectedOffset += chunk.bytes.byteLength;
        }
        const produced = concat(chunks.map((c) => c.bytes));
        const reference = await drain(createStreamingZip([file]).stream);
        expect(produced).toEqual(reference);
    });

    it('stores entries under the provided names', async () => {
        const file = new File([new Uint8Array([9, 8, 7])], 'original.bin', {
            lastModified: 1_700_000_000_000,
        });
        const chunks = await collect(createZipProducer([file], ['renamed.bin']));
        const zip = await JSZip.loadAsync(concat(chunks.map((c) => c.bytes)));
        expect(Object.keys(zip.files)).toEqual(['renamed.bin']);
        expect(new Uint8Array((await zip.file('renamed.bin')?.async('uint8array')) ?? [])).toEqual(
            new Uint8Array([9, 8, 7]),
        );
    });
});
