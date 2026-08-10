/**
 * Bolter streaming-download service worker.
 *
 * Browsers without the File System Access API (Safari, Firefox) cannot write a
 * decrypted download to disk incrementally from page JS. This worker provides
 * the fallback: the page hands it a MessagePort, streams decrypted chunks over
 * that port, and then navigates a hidden iframe to a synthetic URL under this
 * worker's scope. The fetch is answered with a `Content-Disposition:
 * attachment` response whose body is the piped stream, so the browser's own
 * download manager writes the bytes straight to disk and the page never
 * retains the whole payload.
 *
 * Registered LAZILY (first streamed download) from `src/lib/stream-saver.ts`
 * with scope `<base>_stream/` so it never intercepts the application's own
 * requests. Plain JS on purpose: it lives in `public/` so Vite copies it to the
 * dist root verbatim with a stable, unhashed URL (a service worker's script URL
 * must not change between deploys).
 */

/* global self */

// Must match STREAM_PATH_SEGMENT in src/lib/stream-saver.ts
const STREAM_MARKER = '/_stream/';

/** id -> { stream, filename, mimeType } awaiting its iframe navigation. */
const pendingStreams = new Map();

self.addEventListener('install', () => {
    // Take over immediately; there is no cached app shell to migrate.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

/**
 * RFC 5987 / RFC 6266 attachment header. The ASCII `filename` is the legacy
 * fallback; `filename*` carries the real UTF-8 name.
 */
function buildContentDisposition(filename) {
    const name = filename && filename.length > 0 ? filename : 'download';
    // Non-ASCII and quoting characters would break the legacy header value.
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'bolter-stream-init') {
        return;
    }
    const port = event.ports?.[0];
    if (!port || typeof data.id !== 'string' || data.id.length === 0) {
        return;
    }

    const id = data.id;
    let controller = null;
    let settled = false;

    const finish = () => {
        settled = true;
        pendingStreams.delete(id);
    };

    const stream = new ReadableStream(
        {
            start(c) {
                controller = c;
            },
            pull() {
                // Credit-based backpressure: MessagePort has none of its own,
                // so the page waits for this signal before sending more.
                port.postMessage({ type: 'pull' });
            },
            cancel() {
                // The user cancelled the browser download, or the tab closed.
                finish();
                port.postMessage({ type: 'cancelled' });
            },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }),
    );

    pendingStreams.set(id, {
        stream,
        filename: typeof data.filename === 'string' ? data.filename : 'download',
        mimeType: typeof data.mimeType === 'string' ? data.mimeType : '',
    });

    port.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg || settled || !controller) {
            return;
        }

        if (msg.type === 'chunk') {
            try {
                controller.enqueue(new Uint8Array(msg.chunk));
            } catch (e) {
                finish();
                port.postMessage({ type: 'error', message: String(e?.message || e) });
                return;
            }
            if (controller.desiredSize !== null && controller.desiredSize > 0) {
                port.postMessage({ type: 'pull' });
            }
            return;
        }

        if (msg.type === 'end') {
            finish();
            try {
                controller.close();
            } catch {
                // Already closed/errored — the download is over either way.
            }
            port.postMessage({ type: 'closed' });
            return;
        }

        if (msg.type === 'abort') {
            finish();
            try {
                controller.error(new Error(msg.reason || 'Download aborted'));
            } catch {
                // Already closed/errored — nothing left to tear down.
            }
            port.postMessage({ type: 'aborted' });
            return;
        }

        if (msg.type === 'ping') {
            // Keeps the worker alive across slow stretches of a long download.
            port.postMessage({ type: 'pong' });
        }
    };

    if (typeof port.start === 'function') {
        port.start();
    }
    port.postMessage({ type: 'ready', id });
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) {
        return;
    }
    const markerIndex = url.pathname.indexOf(STREAM_MARKER);
    if (markerIndex === -1) {
        return;
    }

    const id = url.pathname.slice(markerIndex + STREAM_MARKER.length);
    const entry = pendingStreams.get(id);
    if (!entry) {
        // Unknown/replayed id — fall through to the network so a stray request
        // never hangs on a stream that will not be fed.
        return;
    }
    pendingStreams.delete(id);

    // Deliberately no Content-Length: the plaintext size recorded at upload
    // time can legitimately drift (iOS lazily transcodes HEIC/HEVC), and a
    // mismatched length would make the browser discard a good download.
    event.respondWith(
        new Response(entry.stream, {
            headers: {
                'Content-Type': entry.mimeType || 'application/octet-stream',
                'Content-Disposition': buildContentDisposition(entry.filename),
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            },
        }),
    );
});
