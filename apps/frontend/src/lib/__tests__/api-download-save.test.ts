import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadWriter, DownloadWriterOptions } from '@/lib/stream-saver';
import { isSavedToDisk } from '@/lib/utils';

/**
 * `downloadFile` used to accumulate every decrypted byte into a `Blob[]`,
 * concatenate it, report the download complete, and hand the Blob back for an
 * object-URL save. Two consequences, both covered here:
 *
 *  - the whole payload had to be materialized before anything was saved, and
 *  - the download credit was burned *before* the save, so a crash during the
 *    save consumed a download and delivered nothing.
 *
 * The stream-saver module is mocked so the writer contract can be observed
 * without a real File System Access / service-worker save target.
 */

const events: string[] = [];
const writtenChunks: Uint8Array[] = [];
let writeShouldFail = false;
let closeShouldFail = false;
let openShouldFail: Error | null = null;
let lastWriterOptions: DownloadWriterOptions | null = null;

const createDownloadWriter = vi.fn((options: DownloadWriterOptions): Promise<DownloadWriter> => {
    lastWriterOptions = options;
    if (openShouldFail) {
        events.push('writer:open-refused');
        return Promise.reject(openShouldFail);
    }
    events.push('writer:open');
    return Promise.resolve({
        strategy: 'file-system-access',
        write(chunk: Uint8Array) {
            if (writeShouldFail) {
                return Promise.reject(new Error('disk full'));
            }
            writtenChunks.push(chunk);
            events.push(`writer:write:${chunk.length}`);
            return Promise.resolve();
        },
        close() {
            if (closeShouldFail) {
                return Promise.reject(new Error('save failed'));
            }
            events.push('writer:close');
            return Promise.resolve();
        },
        abort() {
            events.push('writer:abort');
            return Promise.resolve();
        },
    });
});

vi.mock('@/lib/stream-saver', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/stream-saver')>();
    return {
        ...actual,
        createDownloadWriter: (o: DownloadWriterOptions) => createDownloadWriter(o),
    };
});

const { downloadFile } = await import('@/lib/api');

const PAYLOAD = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7])];
const PAYLOAD_SIZE = PAYLOAD.reduce((n, c) => n + c.length, 0);

interface FakeResponseInit {
    status?: number;
    headers?: Record<string, string>;
    json?: unknown;
    body?: ReadableStream<Uint8Array> | null;
}

function fakeResponse(init: FakeResponseInit): Response {
    const status = init.status ?? 200;
    const headers = new Map(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
        json: () => Promise.resolve(init.json),
        body: init.body ?? null,
    } as unknown as Response;
}

function payloadStream(chunks: Uint8Array[] = PAYLOAD): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(chunks[i++]);
        },
        cancel() {
            // Proves a refused save target does not leave the transfer running.
            events.push('body:cancel');
        },
    });
}

function encodeMetadata(meta: Record<string, unknown>): string {
    return btoa(JSON.stringify(meta));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

interface RouteOptions {
    metadata?: Record<string, unknown>;
    contentLength?: number;
    payload?: Uint8Array[];
}

function installFetch(options: RouteOptions = {}) {
    const metadata = options.metadata ?? {
        name: 'movie.mkv',
        size: PAYLOAD_SIZE,
        type: 'video/x-matroska',
    };
    const payload = options.payload ?? PAYLOAD;
    const contentLength =
        options.contentLength ?? payload.reduce((n: number, c: Uint8Array) => n + c.length, 0);

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/metadata/')) {
            return Promise.resolve(
                fakeResponse({
                    json: { encrypted: false, metadata: encodeMetadata(metadata), ttl: 3600 },
                }),
            );
        }
        if (url.includes('/download/url/')) {
            return Promise.resolve(
                fakeResponse({ json: { useSignedUrl: true, url: 'https://s3.test/object' } }),
            );
        }
        if (url === 'https://s3.test/object') {
            return Promise.resolve(
                fakeResponse({
                    headers: { 'Content-Length': String(contentLength) },
                    body: payloadStream(payload),
                }),
            );
        }
        if (url.includes('/download/complete/')) {
            events.push('report:complete');
            return Promise.resolve(fakeResponse({ json: { ok: true } }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('downloadFile save pipeline', () => {
    beforeEach(() => {
        events.length = 0;
        writtenChunks.length = 0;
        writeShouldFail = false;
        closeShouldFail = false;
        openShouldFail = null;
        lastWriterOptions = null;
        createDownloadWriter.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('streams the payload to the writer instead of buffering it into a Blob', async () => {
        installFetch();
        const result = await downloadFile('abc123', null);

        expect(createDownloadWriter).toHaveBeenCalledTimes(1);
        expect(lastWriterOptions).toMatchObject({
            filename: 'movie.mkv',
            expectedSize: PAYLOAD_SIZE,
        });
        expect(writtenChunks.flatMap((c) => [...c])).toEqual([1, 2, 3, 4, 5, 6, 7]);

        // Nothing is handed back for a second, object-URL save: the bytes are
        // already on disk. The placeholder is empty and explicitly marked.
        expect(result.filename).toBe('movie.mkv');
        expect(result.blob.size).toBe(0);
        expect(isSavedToDisk(result.blob)).toBe(true);
    });

    it('reports the download complete only AFTER the save has landed', async () => {
        installFetch();
        await downloadFile('abc123', null);

        const closeIndex = events.indexOf('writer:close');
        const reportIndex = events.indexOf('report:complete');
        expect(closeIndex).toBeGreaterThanOrEqual(0);
        expect(reportIndex).toBeGreaterThanOrEqual(0);
        // Pre-fix the POST happened first, so an OOM while materializing the
        // Blob burned a download credit and delivered nothing.
        expect(closeIndex).toBeLessThan(reportIndex);
    });

    it('does not burn a download credit when committing the save fails', async () => {
        installFetch();
        closeShouldFail = true;

        await expect(downloadFile('abc123', null)).rejects.toThrow('save failed');
        expect(events).not.toContain('report:complete');
    });

    it('aborts the partially written file and reports nothing when the stream fails', async () => {
        installFetch();
        writeShouldFail = true;

        await expect(downloadFile('abc123', null)).rejects.toThrow(/Download stream failed/);
        expect(events).toContain('writer:abort');
        expect(events).not.toContain('report:complete');
    });

    it('names and types a zipped-at-upload payload from its zip metadata', async () => {
        installFetch({
            metadata: {
                name: 'bundle',
                size: PAYLOAD_SIZE,
                zipped: true,
                zipFilename: 'bolter-files.zip',
                files: [
                    { name: 'a.txt', size: 4 },
                    { name: 'b.txt', size: 3 },
                ],
            },
        });

        const result = await downloadFile('abc123', null);
        expect(lastWriterOptions).toMatchObject({
            filename: 'bolter-files.zip',
            mimeType: 'application/zip',
        });
        expect(result.filename).toBe('bolter-files.zip');
        expect(isSavedToDisk(result.blob)).toBe(true);
    });

    it('never commits the save when the transfer is truncated', async () => {
        // Content-Length promises more than the body delivers.
        installFetch({ contentLength: PAYLOAD_SIZE + 10 });

        await expect(downloadFile('abc123', null)).rejects.toThrow(/Download incomplete/);
        expect(events).not.toContain('writer:close');
        expect(events).not.toContain('report:complete');
        // The integrity guards run after the pump, so they have to tear the
        // writer down themselves or a truncated file is left on disk.
        expect(events).toContain('writer:abort');
    });

    it('drops the in-flight transfer when no save target can be opened', async () => {
        installFetch();
        openShouldFail = new Error('too large to buffer');

        await expect(downloadFile('abc123', null)).rejects.toThrow('too large to buffer');
        expect(events).toContain('body:cancel');
        expect(events).not.toContain('report:complete');
    });
});

/**
 * The legacy (not-zipped-at-upload) multi-file path is the one the audit finding
 * names first and the worst offender: it buffered the whole ciphertext, the
 * whole plaintext AND the whole zip, then POSTed `/download/complete` before
 * handing the archive back to the caller to save.
 */
describe('downloadFile legacy multi-file save pipeline', () => {
    const LEGACY_FILES = [
        { name: 'alpha.txt', size: 5, type: 'text/plain' },
        { name: 'beta.txt', size: 4, type: 'text/plain' },
    ];
    const LEGACY_PAYLOAD = [
        new TextEncoder().encode('AAA'),
        new TextEncoder().encode('AABB'),
        new TextEncoder().encode('BB'),
    ];
    const LEGACY_METADATA = {
        name: 'alpha.txt',
        size: 9,
        // No `zipped` flag + more than one file is exactly the legacy branch.
        files: LEGACY_FILES,
    };

    function installLegacyFetch(overrides: RouteOptions = {}) {
        return installFetch({
            metadata: LEGACY_METADATA,
            payload: LEGACY_PAYLOAD,
            ...overrides,
        });
    }

    beforeEach(() => {
        events.length = 0;
        writtenChunks.length = 0;
        writeShouldFail = false;
        closeShouldFail = false;
        openShouldFail = null;
        lastWriterOptions = null;
        createDownloadWriter.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('streams the archive to a save target instead of returning a Blob', async () => {
        installLegacyFetch();
        const result = await downloadFile('abc123', null);

        expect(createDownloadWriter).toHaveBeenCalledTimes(1);
        expect(lastWriterOptions).toMatchObject({
            filename: 'files-2.zip',
            mimeType: 'application/zip',
        });

        // A real zip landed in the writer, not in the returned Blob.
        const zip = await JSZip.loadAsync(concatChunks(writtenChunks));
        expect(Object.keys(zip.files).sort()).toEqual(['alpha.txt', 'beta.txt']);
        expect(await zip.file('alpha.txt')?.async('string')).toBe('AAAAA');
        expect(await zip.file('beta.txt')?.async('string')).toBe('BBBB');

        expect(result.filename).toBe('files-2.zip');
        expect(result.blob.size).toBe(0);
        expect(isSavedToDisk(result.blob)).toBe(true);
    });

    it('opens the save target before pulling a single payload byte', async () => {
        // Pre-fix nothing gated this path at all — a 20GB legacy link was
        // transferred in full and only then blew up building the Blob.
        installLegacyFetch();
        openShouldFail = new Error('cannot buffer 20 GB');

        await expect(downloadFile('abc123', null)).rejects.toThrow('cannot buffer 20 GB');
        expect(writtenChunks).toHaveLength(0);
        expect(events).toContain('body:cancel');
        expect(events).not.toContain('report:complete');
    });

    it('reports the download complete only AFTER the archive has been saved', async () => {
        installLegacyFetch();
        await downloadFile('abc123', null);

        const closeIndex = events.indexOf('writer:close');
        const reportIndex = events.indexOf('report:complete');
        expect(closeIndex).toBeGreaterThanOrEqual(0);
        expect(reportIndex).toBeGreaterThanOrEqual(0);
        // Pre-fix the POST fired inside downloadFileLegacyMultiFile, before the
        // caller had even been handed the zip Blob to save.
        expect(closeIndex).toBeLessThan(reportIndex);
    });

    it('does not burn a download credit when committing the archive fails', async () => {
        installLegacyFetch();
        closeShouldFail = true;

        await expect(downloadFile('abc123', null)).rejects.toThrow('save failed');
        expect(events).not.toContain('report:complete');
    });

    it('aborts the archive and reports nothing when the transfer is truncated', async () => {
        installLegacyFetch({ contentLength: 99 });

        await expect(downloadFile('abc123', null)).rejects.toThrow(/Download incomplete/);
        expect(events).toContain('writer:abort');
        expect(events).not.toContain('writer:close');
        expect(events).not.toContain('report:complete');
    });

    it('still completes when the payload runs longer than its metadata', async () => {
        // Legacy uploads can carry drifted sizes in either direction. The
        // buffered implementation read the whole body and dropped the tail;
        // stopping at the last entry instead would leave bytes unread and make
        // the Content-Length reconciliation call an intact download truncated.
        installLegacyFetch({
            payload: [...LEGACY_PAYLOAD, new TextEncoder().encode('EXTRA')],
        });

        const result = await downloadFile('abc123', null);
        const zip = await JSZip.loadAsync(concatChunks(writtenChunks));
        expect(await zip.file('beta.txt')?.async('string')).toBe('BBBB');
        expect(events).toContain('report:complete');
        expect(isSavedToDisk(result.blob)).toBe(true);
    });

    it('aborts the archive when the save target fails mid-stream', async () => {
        installLegacyFetch();
        writeShouldFail = true;

        await expect(downloadFile('abc123', null)).rejects.toThrow(/Download stream failed/);
        expect(events).toContain('writer:abort');
        expect(events).not.toContain('report:complete');
    });
});
