import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createZipStreamFromConcatenated, type FileInfo } from '@/lib/zip';

/**
 * `createZipStreamFromConcatenated` replaced the legacy multi-file download's
 * buffer-everything pipeline (whole ciphertext Blob → whole plaintext Blob →
 * whole zip Blob). These tests pin the properties that made the replacement
 * safe: the split is byte-exact, nothing is retained, and a payload that is
 * shorter than its metadata still yields a valid archive.
 */

function textBytes(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

/** Emit a payload in fixed-size chunks so chunk and file boundaries disagree. */
function chunkedStream(
    data: Uint8Array,
    chunkSize: number,
    hooks: { onPull?: (sent: number) => void; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= data.length) {
                controller.close();
                return;
            }
            const end = Math.min(offset + chunkSize, data.length);
            controller.enqueue(data.subarray(offset, end));
            offset = end;
            hooks.onPull?.(offset);
        },
        cancel() {
            hooks.onCancel?.();
        },
    });
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

const FILES: FileInfo[] = [
    { name: 'alpha.txt', size: 5, type: 'text/plain' },
    { name: 'beta.bin', size: 9, type: 'application/octet-stream' },
    { name: 'gamma.txt', size: 3, type: 'text/plain' },
];
const PAYLOAD = concat([textBytes('AAAAA'), textBytes('BBBBBBBBB'), textBytes('CCC')]);

describe('createZipStreamFromConcatenated', () => {
    it('splits the concatenated payload back into byte-exact entries', async () => {
        const { stream } = createZipStreamFromConcatenated(chunkedStream(PAYLOAD, 4), FILES);
        const zip = await JSZip.loadAsync(await drain(stream));

        expect(Object.keys(zip.files).sort()).toEqual(['alpha.txt', 'beta.bin', 'gamma.txt']);
        expect(await zip.file('alpha.txt')?.async('string')).toBe('AAAAA');
        expect(await zip.file('beta.bin')?.async('string')).toBe('BBBBBBBBB');
        expect(await zip.file('gamma.txt')?.async('string')).toBe('CCC');
    });

    it('produces zip bytes before the payload has been fully read', async () => {
        // The whole point of the rewrite: no full materialization. If the
        // implementation buffered the payload first, the source would be
        // drained to completion before a single zip byte appeared.
        let pulled = 0;
        const big = new Uint8Array(64 * 1024).fill(7);
        const files: FileInfo[] = [
            { name: 'one.bin', size: 32 * 1024, type: 'application/octet-stream' },
            { name: 'two.bin', size: 32 * 1024, type: 'application/octet-stream' },
        ];
        const { stream } = createZipStreamFromConcatenated(
            chunkedStream(big, 1024, { onPull: (sent) => (pulled = sent) }),
            files,
        );

        const reader = stream.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(pulled).toBeLessThan(big.length);
        await reader.cancel();
    });

    it('consumes trailing bytes no entry laid claim to', async () => {
        // Metadata can under-count the payload as easily as over-count it, and
        // the caller reconciles bytes received against Content-Length —
        // cancelling the tail would make an intact download look truncated.
        let pulled = 0;
        let cancelled = false;
        const withTail = concat([PAYLOAD, textBytes('TAIL')]);
        const { stream } = createZipStreamFromConcatenated(
            chunkedStream(withTail, 6, {
                onPull: (sent) => (pulled = sent),
                onCancel: () => (cancelled = true),
            }),
            FILES,
        );

        const zip = await JSZip.loadAsync(await drain(stream));
        expect(pulled).toBe(withTail.length);
        expect(cancelled).toBe(false);
        // The tail is discarded, not appended to the last entry.
        expect(await zip.file('gamma.txt')?.async('string')).toBe('CCC');
    });

    it('abandons the payload stream when the zip consumer goes away', async () => {
        let cancelled = false;
        const { stream } = createZipStreamFromConcatenated(
            chunkedStream(PAYLOAD, 2, { onCancel: () => (cancelled = true) }),
            FILES,
        );

        const reader = stream.getReader();
        await reader.read();
        await reader.cancel();
        // The generator's teardown is scheduled by client-zip's cancel path.
        await new Promise((r) => setTimeout(r, 0));
        expect(cancelled).toBe(true);
    });

    it('truncates trailing entries when the payload is shorter than its metadata', async () => {
        // Legacy uploads can carry drifted sizes (iOS lazy transcoding). The
        // archive must still be readable rather than failing outright.
        const short = concat([textBytes('AAAAA'), textBytes('BBBB')]);
        const { stream } = createZipStreamFromConcatenated(chunkedStream(short, 3), FILES);
        const zip = await JSZip.loadAsync(await drain(stream));

        expect(await zip.file('alpha.txt')?.async('string')).toBe('AAAAA');
        expect(await zip.file('beta.bin')?.async('string')).toBe('BBBB');
        expect(await zip.file('gamma.txt')?.async('string')).toBe('');
    });

    it('deduplicates repeated filenames and names anonymous entries', async () => {
        const dupes: FileInfo[] = [
            { name: 'note.txt', size: 2, type: 'text/plain' },
            { name: 'note.txt', size: 2, type: 'text/plain' },
            { name: '', size: 2, type: 'text/plain' },
        ];
        const { stream } = createZipStreamFromConcatenated(
            chunkedStream(textBytes('ab' + 'cd' + 'ef'), 5),
            dupes,
        );
        const zip = await JSZip.loadAsync(await drain(stream));

        expect(Object.keys(zip.files).sort()).toEqual(['file-3', 'note (1).txt', 'note.txt']);
        expect(await zip.file('note.txt')?.async('string')).toBe('ab');
        expect(await zip.file('note (1).txt')?.async('string')).toBe('cd');
        expect(await zip.file('file-3')?.async('string')).toBe('ef');
    });

    it('estimates the archive size from the declared entry sizes', async () => {
        const { stream, estimatedSize } = createZipStreamFromConcatenated(
            chunkedStream(PAYLOAD, 4),
            FILES,
        );
        const bytes = await drain(stream);
        // Exact when metadata matches the payload — this is the number the save
        // target's size gate is given before any bytes are transferred.
        expect(estimatedSize).toBe(bytes.length);
    });
});
