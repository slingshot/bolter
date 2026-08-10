/**
 * Shared XMLHttpRequest fake for the upload-path tests.
 *
 * Not a `*.test.ts` file, so vitest does not collect it.
 *
 * Faithful to the parts of the XHR contract the uploader depends on:
 *  - `loadend` is the single terminal event and fires for success, error AND
 *    abort (the uploader relies on this to unregister itself)
 *  - `abort()` transitions to DONE and dispatches `loadend` synchronously
 *  - `getResponseHeader('ETag')` is exposed (bucket CORS dependency)
 */
export class FakeXhr {
    static DONE = 4;

    /** Every instance created, in creation order. */
    static instances: FakeXhr[] = [];
    /** One entry per send(), in send order. */
    static sends: Array<{ url: string; size: number }> = [];
    /**
     * Called on every send. Decides what the request does — the default
     * succeeds on the next microtask.
     */
    static onSend: (xhr: FakeXhr) => void = (xhr) => {
        queueMicrotask(() => xhr.succeed());
    };

    static reset() {
        FakeXhr.instances = [];
        FakeXhr.sends = [];
        FakeXhr.onSend = (xhr) => {
            queueMicrotask(() => xhr.succeed());
        };
    }

    readyState = 0;
    status = 0;
    statusText = '';
    responseText = '';
    url = '';
    aborted = false;
    sentSize = 0;

    private listeners: Record<string, Array<() => void>> = {};
    private uploadListeners: Record<string, Array<(e: unknown) => void>> = {};

    upload = {
        addEventListener: (event: string, fn: (e: unknown) => void) => {
            const list = this.uploadListeners[event] ?? [];
            list.push(fn);
            this.uploadListeners[event] = list;
        },
        removeEventListener: () => {
            /* noop */
        },
    };

    addEventListener(event: string, fn: () => void) {
        const list = this.listeners[event] ?? [];
        list.push(fn);
        this.listeners[event] = list;
    }

    removeEventListener() {
        /* noop */
    }

    getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'etag' ? '"fake-etag"' : null;
    }

    setRequestHeader() {
        /* noop */
    }

    open(_method: string, url: string) {
        this.url = url;
        this.readyState = 1;
    }

    send(body: Blob | null) {
        this.sentSize = body && 'size' in body ? body.size : 0;
        FakeXhr.instances.push(this);
        FakeXhr.sends.push({ url: this.url, size: this.sentSize });
        this.dispatch('loadstart');
        FakeXhr.onSend(this);
    }

    abort() {
        if (this.readyState === FakeXhr.DONE) {
            return;
        }
        this.aborted = true;
        this.status = 0;
        this.readyState = FakeXhr.DONE;
        // Real XHRs dispatch loadend synchronously from abort()
        this.dispatch('loadend');
    }

    /** Report upload progress for `loaded` bytes. */
    progress(loaded: number) {
        for (const fn of this.uploadListeners.progress ?? []) {
            fn({ lengthComputable: true, loaded, total: this.sentSize });
        }
    }

    succeed() {
        if (this.readyState === FakeXhr.DONE) {
            return;
        }
        this.progress(this.sentSize);
        this.status = 200;
        this.statusText = 'OK';
        this.readyState = FakeXhr.DONE;
        this.dispatch('loadend');
    }

    failWithStatus(status: number, statusText = 'Error') {
        if (this.readyState === FakeXhr.DONE) {
            return;
        }
        this.status = status;
        this.statusText = statusText;
        this.readyState = FakeXhr.DONE;
        this.dispatch('loadend');
    }

    /** Network-level failure (fires `error`, then `loadend` like a real XHR). */
    failWithNetworkError() {
        if (this.readyState === FakeXhr.DONE) {
            return;
        }
        this.status = 0;
        this.readyState = FakeXhr.DONE;
        this.dispatch('error');
        this.dispatch('loadend');
    }

    private dispatch(event: string) {
        for (const fn of [...(this.listeners[event] ?? [])]) {
            fn();
        }
    }
}

/**
 * A File whose `stream()` yields `totalBytes` in `chunkSize` pieces.
 *
 * happy-dom's Blob.stream() emits the entire blob as a single chunk, which the
 * uploader turns into one oversized trailing part — useless for exercising the
 * multi-part read loop. This keeps chunking explicit (and avoids allocating the
 * whole payload up front).
 */
export function chunkedFile(name: string, totalBytes: number, chunkSize: number): File {
    const file = new File([new Uint8Array(0)], name, {
        type: 'application/octet-stream',
        lastModified: 1700000000000,
    });
    Object.defineProperty(file, 'size', { value: totalBytes });
    Object.defineProperty(file, 'stream', {
        value: () => {
            let sent = 0;
            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (sent >= totalBytes) {
                        controller.close();
                        return;
                    }
                    const n = Math.min(chunkSize, totalBytes - sent);
                    sent += n;
                    controller.enqueue(new Uint8Array(n));
                },
            });
        },
    });
    return file;
}

/** Minimal /upload/url response for a multipart upload of `numParts` parts. */
export function multipartUploadInfo(numParts: number, partSize: number) {
    return {
        useSignedUrl: true,
        multipart: true,
        id: 'file-id',
        owner: 'owner-token',
        uploadId: 'upload-id',
        partSize,
        url: '',
        parts: Array.from({ length: numParts }, (_, i) => ({
            partNumber: i + 1,
            url: `https://s3.example.com/part${i + 1}`,
            minSize: 0,
            maxSize: partSize,
        })),
    };
}
