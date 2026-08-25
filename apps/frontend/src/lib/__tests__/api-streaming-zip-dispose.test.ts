import { Keychain } from '@bolter/protocol/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Canceller, uploadFiles } from '@/lib/api';

/**
 * Audit finding 34 — cancelling a streaming-zip upload must cancel every
 * per-file source stream.
 *
 * `createStreamingZip` exposes `dispose()`, but the leak is only actually
 * closed if `uploadFiles` retains the handle and calls it. These tests drive
 * the real `uploadFiles` streaming-zip path end to end and assert that both an
 * already-started source (its reader acquired and locked by client-zip) and a
 * not-yet-reached source receive `cancel()`.
 *
 * Pre-fix (`uploadFiles` destructuring only `.stream/.filename/.estimatedSize`)
 * neither source is ever cancelled and both assertions fail.
 */

const PART_SIZE = 5 * 1024 * 1024; // MIN_PART_SIZE — smallest legal S3/R2 part
const CHUNK_SIZE = 1024 * 1024;

interface FakeSource {
    file: File;
    /** Times the underlying source stream's cancel algorithm ran. */
    cancelCount: number;
    /** Whether anything ever pulled from this file. */
    started: boolean;
}

/**
 * A File-like whose stream never ends, so it is still open (and, once
 * client-zip starts reading it, locked) when the cancellation lands.
 */
function makeFakeFile(name: string, size: number): FakeSource {
    const source: FakeSource = {
        cancelCount: 0,
        started: false,
        file: null as unknown as File,
    };

    source.file = {
        name,
        size,
        type: 'application/octet-stream',
        lastModified: 1700000000000,
        stream(): ReadableStream<Uint8Array> {
            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    source.started = true;
                    controller.enqueue(new Uint8Array(CHUNK_SIZE));
                },
                cancel() {
                    source.cancelCount++;
                },
            });
        },
    } as unknown as File;

    return source;
}

/** Invoked from FakeXHR.send() so a test can cancel mid-part-upload. */
let onPartSend: (() => void) | null = null;

class FakeXHR {
    static DONE = 4;

    readyState = 1; // OPENED — in flight
    status = 200;
    statusText = 'OK';
    responseText = '';
    upload = {
        addEventListener: () => {
            /* progress events not simulated */
        },
    };
    private listeners: Record<string, Array<() => void>> = {};

    addEventListener(event: string, fn: () => void) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(fn);
    }

    getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'etag' ? '"fake-etag"' : null;
    }

    open() {
        /* noop */
    }

    /** Real XHRs fire loadend synchronously from abort(). */
    abort() {
        this.status = 0;
        this.readyState = 4;
        this.dispatch('loadend');
    }

    send() {
        onPartSend?.();
    }

    private dispatch(event: string) {
        for (const fn of this.listeners[event] ?? []) {
            fn();
        }
    }
}

function uploadUrlResponse() {
    return {
        useSignedUrl: true,
        multipart: true,
        id: 'file-id',
        owner: 'owner-token',
        uploadId: 'upload-id',
        partSize: PART_SIZE,
        url: 'https://s3.example.com/single',
        parts: Array.from({ length: 8 }, (_, i) => ({
            partNumber: i + 1,
            url: `https://s3.example.com/part${i + 1}`,
        })),
    };
}

describe('uploadFiles — streaming zip disposal (finding 34)', () => {
    let uploadUrlStatus: number;

    beforeEach(() => {
        onPartSend = null;
        uploadUrlStatus = 200;
        vi.stubGlobal('XMLHttpRequest', FakeXHR);
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                const target = String(url);
                if (target.includes('/upload/url')) {
                    return Promise.resolve(
                        new Response(JSON.stringify(uploadUrlResponse()), {
                            status: uploadUrlStatus,
                        }),
                    );
                }
                if (target.includes('/upload/abort')) {
                    return Promise.resolve(new Response('{}', { status: 200 }));
                }
                return Promise.reject(new Error(`Unexpected fetch: ${target}`));
            }),
        );
    });

    afterEach(() => {
        onPartSend = null;
        vi.unstubAllGlobals();
    });

    it('cancels every per-file source when the upload is cancelled mid-flight', async () => {
        // 2 x 600MB clears the streaming-zip threshold on every UA.
        const first = makeFakeFile('first.bin', 600 * 1024 * 1024);
        const second = makeFakeFile('second.bin', 600 * 1024 * 1024);
        const canceller = new Canceller();

        // Cancel as soon as the first part hits the wire — the audit's
        // scenario (a large multi-file upload cancelled a few percent in).
        onPartSend = () => canceller.cancel();

        await expect(
            uploadFiles(
                { files: [first.file, second.file], encrypted: false },
                new Keychain(),
                canceller,
            ),
        ).rejects.toThrow();

        // The first entry is the one being streamed, so its source reader is
        // acquired and locked at cancellation time — exactly the state the
        // audit describes for a large upload cancelled a few percent in.
        expect(first.started).toBe(true);

        // Pre-fix: dispose() existed but nothing called it, so neither source
        // was ever cancelled — both counts stayed 0.
        expect(first.cancelCount).toBeGreaterThan(0);
        expect(second.cancelCount).toBeGreaterThan(0);
    });

    it('cancels every per-file source when the upload fails before the first part', async () => {
        const first = makeFakeFile('first.bin', 600 * 1024 * 1024);
        const second = makeFakeFile('second.bin', 600 * 1024 * 1024);
        uploadUrlStatus = 500;

        await expect(
            uploadFiles(
                { files: [first.file, second.file], encrypted: false },
                new Keychain(),
                new Canceller(),
            ),
        ).rejects.toThrow('HTTP 500');

        // The zip is constructed before /upload/url is requested, so a failure
        // in that window must release the sources too.
        expect(first.cancelCount).toBeGreaterThan(0);
        expect(second.cancelCount).toBeGreaterThan(0);
    });
});
