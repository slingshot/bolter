import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
    assertZipFitsWithoutZip64,
    createNameDeduplicator,
    createStreamingZip,
    createZipFromFiles,
    createZipFromUploadFiles,
    createZipStreamFromConcatenated,
    type FileInfo,
    type FileSlice,
    generateZipFilename,
    projectZipArchiveSize,
    sanitizeZipEntryName,
    ZIP32_MAX_BYTES,
    ZIP32_MAX_ENTRIES,
} from '@/lib/zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function slice(name: string, contents: string): FileSlice {
    return { name, data: encoder.encode(contents), type: 'text/plain' };
}

function uploadFile(name: string, contents: string): File {
    return new File([encoder.encode(contents)], name, { type: 'text/plain' });
}

async function readZipEntries(blob: Blob): Promise<Record<string, string>> {
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
    const entries: Record<string, string> = {};
    for (const name of Object.keys(zip.files)) {
        const entry = zip.files[name];
        // JSZip synthesizes directory entries for nested paths; only files matter here.
        if (entry.dir) {
            continue;
        }
        entries[name] = decoder.decode(await entry.async('uint8array'));
    }
    return entries;
}

async function readStreamingZipEntries(
    stream: ReadableStream<Uint8Array>,
): Promise<Record<string, string>> {
    const buffer = await new Response(stream).arrayBuffer();
    return readZipEntries(new Blob([buffer]));
}

/**
 * A Blob whose reported size is a lie. Lets the >= 4 GiB ZIP64 guard be
 * exercised without allocating 4 GiB.
 */
function blobOfDeclaredSize(size: number): Blob {
    const blob = new Blob([new Uint8Array(1)]);
    Object.defineProperty(blob, 'size', { value: size });
    return blob;
}

/**
 * A File-like object whose `stream()` hands back an instrumented source, so a
 * test can observe when the reader is acquired and when the source is cancelled.
 */
function instrumentedFile(name: string, contents: string, chunkCount = 1) {
    const bytes = encoder.encode(contents);
    let emitted = 0;
    const spy = { getReaderCalls: 0, cancelCalls: 0 };

    const source = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (emitted >= chunkCount) {
                controller.close();
                return;
            }
            emitted++;
            controller.enqueue(bytes);
        },
        cancel() {
            spy.cancelCalls++;
        },
    });

    const originalGetReader = source.getReader.bind(source);
    source.getReader = ((options?: { mode?: 'byob' }) => {
        spy.getReaderCalls++;
        return originalGetReader(options as never);
    }) as typeof source.getReader;

    const file = {
        name,
        size: bytes.byteLength * chunkCount,
        type: 'text/plain',
        lastModified: 0,
        stream: () => source,
    } as unknown as File;

    return { file, spy };
}

describe('createNameDeduplicator (finding 4)', () => {
    it('never hands out a generated name that collides with a real entry', () => {
        const next = createNameDeduplicator();

        // The pre-fix counter only tracked the ORIGINAL names, so the third
        // file's literal "report (1).pdf" was treated as unseen and reused the
        // name already minted for the second file.
        expect(next('report.pdf')).toBe('report.pdf');
        expect(next('report.pdf')).toBe('report (1).pdf');
        expect(next('report (1).pdf')).toBe('report (2).pdf');
    });

    it('keeps incrementing past a chain of pre-existing generated names', () => {
        const next = createNameDeduplicator();

        expect(next('a.txt')).toBe('a.txt');
        expect(next('a (1).txt')).toBe('a (1).txt');
        expect(next('a (2).txt')).toBe('a (2).txt');
        expect(next('a.txt')).toBe('a (3).txt');
    });

    it('handles extensionless and dotfile names', () => {
        const next = createNameDeduplicator();

        expect(next('README')).toBe('README');
        expect(next('README')).toBe('README (1)');
        expect(next('.env')).toBe('.env');
        expect(next('.env')).toBe('.env (1)');
    });

    it('de-duplicates names that only collide after sanitization', () => {
        const next = createNameDeduplicator();

        expect(next('notes.txt')).toBe('notes.txt');
        expect(next('/notes.txt')).toBe('notes (1).txt');
    });
});

describe('sanitizeZipEntryName (finding 33)', () => {
    it('strips parent-directory traversal segments', () => {
        expect(sanitizeZipEntryName('../../../.bashrc')).toBe('.bashrc');
        expect(sanitizeZipEntryName('../../../../home/user/.profile')).toBe('home/user/.profile');
        expect(sanitizeZipEntryName('a/../../b/c.txt')).toBe('a/b/c.txt');
    });

    it('strips absolute paths and drive prefixes', () => {
        expect(sanitizeZipEntryName('/etc/cron.d/x')).toBe('etc/cron.d/x');
        expect(sanitizeZipEntryName('///etc/passwd')).toBe('etc/passwd');
        expect(sanitizeZipEntryName('C:\\Windows\\System32\\evil.dll')).toBe(
            'Windows/System32/evil.dll',
        );
        expect(sanitizeZipEntryName('C:evil.dll')).toBe('evil.dll');
        // Stacked prefixes: a single strip pass leaves a literal `C:` segment
        expect(sanitizeZipEntryName('C:C:/evil.dll')).toBe('evil.dll');
        expect(sanitizeZipEntryName('/C:/D:/evil.dll')).toBe('evil.dll');
    });

    it('normalizes backslash separators and drops "." segments', () => {
        expect(sanitizeZipEntryName('a\\b\\c.txt')).toBe('a/b/c.txt');
        expect(sanitizeZipEntryName('./a/./b.txt')).toBe('a/b.txt');
    });

    it('drops control characters', () => {
        expect(sanitizeZipEntryName('re\u0000port\u001f.pdf\u007f')).toBe('report.pdf');
        expect(sanitizeZipEntryName('line\nbreak.txt')).toBe('linebreak.txt');
    });

    it('falls back when nothing survives sanitization', () => {
        expect(sanitizeZipEntryName('../../..')).toBe('unnamed');
        expect(sanitizeZipEntryName('/')).toBe('unnamed');
        expect(sanitizeZipEntryName('\u0000')).toBe('unnamed');
    });

    it('leaves ordinary names untouched', () => {
        expect(sanitizeZipEntryName('report.pdf')).toBe('report.pdf');
        expect(sanitizeZipEntryName('photos/holiday (1).jpg')).toBe('photos/holiday (1).jpg');
        expect(sanitizeZipEntryName('..hidden.txt')).toBe('..hidden.txt');
    });
});

describe('createZipFromFiles (findings 4, 22, 33)', () => {
    it('delivers every file when a generated duplicate name collides with a real one', async () => {
        const blob = await createZipFromFiles([
            slice('report.pdf', 'first'),
            slice('report.pdf', 'second'),
            slice('report (1).pdf', 'third'),
        ]);

        const entries = await readZipEntries(blob);

        // Pre-fix the third slice reused "report (1).pdf" and JSZip silently
        // replaced the second slice's bytes — the archive shipped 2 of 3 files.
        expect(Object.keys(entries)).toHaveLength(3);
        expect(entries['report.pdf']).toBe('first');
        expect(entries['report (1).pdf']).toBe('second');
        expect(entries['report (2).pdf']).toBe('third');
    });

    it('sanitizes traversal entry names before they reach the archive headers', async () => {
        const blob = await createZipFromFiles([
            slice('../../../../home/user/.profile', 'payload'),
            slice('/etc/cron.d/x', 'cron'),
        ]);

        const entries = await readZipEntries(blob);

        expect(Object.keys(entries).sort()).toEqual(['etc/cron.d/x', 'home/user/.profile']);
    });

    it('rejects a single entry at or above the 4 GiB non-ZIP64 limit', async () => {
        await expect(
            createZipFromFiles([
                { name: 'huge.bin', data: blobOfDeclaredSize(ZIP32_MAX_BYTES), type: '' },
            ]),
        ).rejects.toThrow(/exceeds the 4 GiB per-entry limit/);
    });

    it('rejects an archive whose projected size crosses 4 GiB', async () => {
        const twoGiB = 2 * 1024 * 1024 * 1024;

        await expect(
            createZipFromFiles([
                { name: 'a.bin', data: blobOfDeclaredSize(twoGiB), type: '' },
                { name: 'b.bin', data: blobOfDeclaredSize(twoGiB), type: '' },
            ]),
        ).rejects.toThrow(/exceeds the 4 GiB limit/);
    });

    it('still builds archives that comfortably fit in 32-bit fields', async () => {
        const blob = await createZipFromFiles([slice('a.txt', 'hello')]);
        expect(await readZipEntries(blob)).toEqual({ 'a.txt': 'hello' });
    });
});

describe('assertZipFitsWithoutZip64 (finding 22)', () => {
    it('accepts an archive just under the limit', () => {
        expect(() =>
            assertZipFitsWithoutZip64([{ name: 'a.bin', size: ZIP32_MAX_BYTES - 1_000 }]),
        ).not.toThrow();
    });

    it('rejects an entry exactly at the limit', () => {
        expect(() => assertZipFitsWithoutZip64([{ name: 'a.bin', size: ZIP32_MAX_BYTES }])).toThrow(
            /huge|exceeds the 4 GiB per-entry limit/,
        );
    });

    it('accounts for per-entry header overhead in the projected size', () => {
        // Payload alone fits; headers push it over.
        expect(() =>
            assertZipFitsWithoutZip64([{ name: 'a.bin', size: ZIP32_MAX_BYTES - 10 }]),
        ).toThrow(/exceeds the 4 GiB limit/);
    });

    it('rejects more entries than the 16-bit EOCD counters can hold', () => {
        // The uploader controls the metadata file list and the server does not
        // cap it, so an over-long list is reachable — and JSZip would wrap the
        // count silently, exactly like the size fields.
        const entries = Array.from({ length: ZIP32_MAX_ENTRIES + 1 }, (_, i) => ({
            name: `f${i}.txt`,
            size: 1,
        }));
        expect(() => assertZipFitsWithoutZip64(entries)).toThrow(/entry limit/);

        const atLimit = Array.from({ length: ZIP32_MAX_ENTRIES }, (_, i) => ({
            name: `f${i}.txt`,
            size: 1,
        }));
        expect(() => assertZipFitsWithoutZip64(atLimit)).not.toThrow();
    });

    it('projects a plausible archive size', () => {
        // 22 (EOCD) + 30 + 5 (name) + 16 (descriptor) + 46 + 5 (name) + 100
        expect(projectZipArchiveSize([{ name: 'a.txt', size: 100 }])).toBe(
            22 + 30 + 16 + 46 + 10 + 100,
        );
    });
});

describe('createZipFromUploadFiles (finding 4)', () => {
    it('never drops a file when a generated name collides with a real one', async () => {
        const { blob } = await createZipFromUploadFiles([
            uploadFile('report.pdf', 'first'),
            uploadFile('report.pdf', 'second'),
            uploadFile('report (1).pdf', 'third'),
        ]);

        const entries = await readZipEntries(blob);

        expect(Object.keys(entries)).toHaveLength(3);
        expect(entries['report.pdf']).toBe('first');
        expect(entries['report (1).pdf']).toBe('second');
        expect(entries['report (2).pdf']).toBe('third');
    });
});

describe('createStreamingZip (findings 4, 33, 34)', () => {
    it('never drops a file when a generated name collides with a real one', async () => {
        const { stream } = createStreamingZip([
            uploadFile('report.pdf', 'first'),
            uploadFile('report.pdf', 'second'),
            uploadFile('report (1).pdf', 'third'),
        ]);

        const entries = await readStreamingZipEntries(stream);

        expect(Object.keys(entries)).toHaveLength(3);
        expect(entries['report.pdf']).toBe('first');
        expect(entries['report (1).pdf']).toBe('second');
        expect(entries['report (2).pdf']).toBe('third');
    });

    it('sanitizes traversal entry names', async () => {
        const { stream } = createStreamingZip([
            uploadFile('../../../../home/user/.profile', 'payload'),
        ]);

        expect(Object.keys(await readStreamingZipEntries(stream))).toEqual(['home/user/.profile']);
    });

    it('does not lock the per-file source streams at construction time', async () => {
        const a = instrumentedFile('a.txt', 'aaa');
        const b = instrumentedFile('b.txt', 'bbb');

        createStreamingZip([a.file, b.file]);

        // Drain the microtask queue before asserting. A ReadableStream built
        // with the default queuing strategy (highWaterMark 1) pulls one chunk
        // as soon as it is constructed, so a synchronous assertion here would
        // pass even with eagerly-acquired readers — the getReader() call just
        // hadn't happened yet.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Pre-fix, createProgressStream called getReader() eagerly for every
        // file, locking all source streams before a single byte was requested.
        expect(a.spy.getReaderCalls).toBe(0);
        expect(b.spy.getReaderCalls).toBe(0);
    });

    it('dispose() cancels every per-file source stream', async () => {
        const a = instrumentedFile('a.txt', 'aaa');
        const b = instrumentedFile('b.txt', 'bbb');

        const zip = createStreamingZip([a.file, b.file]);
        await zip.dispose();

        // Pre-fix there was no dispose(): cancelling an upload released the
        // zip stream's lock and left every file stream suspended and locked.
        expect(a.spy.cancelCalls).toBe(1);
        expect(b.spy.cancelCalls).toBe(1);
    });

    it('dispose() cancels through an already-acquired reader mid-stream', async () => {
        // Several chunks, so the source is still open when dispose() lands.
        const a = instrumentedFile('a.txt', 'aaa', 8);

        const zip = createStreamingZip([a.file]);

        // Pump the zip until the entry's source reader has been acquired.
        const reader = zip.stream.getReader();
        for (let i = 0; i < 10 && a.spy.getReaderCalls === 0; i++) {
            await reader.read();
        }
        expect(a.spy.getReaderCalls).toBe(1);
        expect(a.spy.cancelCalls).toBe(0);

        await zip.dispose();
        expect(a.spy.cancelCalls).toBe(1);

        reader.releaseLock();
    });

    it('dispose() is idempotent and never rejects', async () => {
        const a = instrumentedFile('a.txt', 'aaa');

        const zip = createStreamingZip([a.file]);
        await expect(zip.dispose()).resolves.toBeUndefined();
        await expect(zip.dispose()).resolves.toBeUndefined();
    });

    it('uses the injected streamFactory instead of file.stream()', async () => {
        const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.bin');
        let streamCalls = 0;
        const originalStream = file.stream.bind(file);
        file.stream = () => {
            streamCalls++;
            return originalStream();
        };
        let factoryCalls = 0;
        const factory = () => {
            factoryCalls++;
            return new Blob([new Uint8Array([1, 2, 3, 4])]).stream() as ReadableStream<Uint8Array>;
        };

        const withFactory = await drain(
            createStreamingZip([file], undefined, { streamFactory: factory }).stream,
        );
        expect(factoryCalls).toBe(1);
        expect(streamCalls).toBe(0);

        const without = await drain(createStreamingZip([file]).stream);
        expect(streamCalls).toBe(1);
        // Same file object → same lastModified in both archives.
        expect(withFactory).toEqual(without); // byte-identical archives
    });
});

describe('generateZipFilename', () => {
    it('keeps ordinary derived names intact', () => {
        expect(
            generateZipFilename([
                { name: 'holiday-01.jpg', size: 1, type: 'image/jpeg' },
                { name: 'holiday-02.jpg', size: 1, type: 'image/jpeg' },
            ]),
        ).toBe('holiday-0.zip');
        expect(generateZipFilename([{ name: 'report.pdf', size: 1, type: '' }])).toBe('report.zip');
        expect(
            generateZipFilename([
                { name: 'a.txt', size: 1, type: '' },
                { name: 'b.txt', size: 1, type: '' },
            ]),
        ).toBe('files-2.zip');
    });

    it('flattens separators and control characters out of the derived name', () => {
        // The archive name is derived from the same uploader-controlled
        // metadata as the entry names and lands in a Save dialog.
        expect(generateZipFilename([{ name: '../../etc/passwd.tar', size: 1, type: '' }])).toBe(
            '.._.._etc_passwd.zip',
        );
        expect(generateZipFilename([{ name: 'a\u0000b.bin', size: 1, type: '' }])).toBe('ab.zip');
        expect(generateZipFilename([{ name: '/', size: 1, type: '' }])).toBe('download.zip');
    });
});

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
