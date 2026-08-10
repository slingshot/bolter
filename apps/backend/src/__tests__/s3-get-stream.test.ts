import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const noopLogger = {
    info: () => {
        /* noop */
    },
    warn: () => {
        /* noop */
    },
    error: () => {
        /* noop */
    },
    debug: () => {
        /* noop */
    },
    child: () => noopLogger,
};
mock.module('../logger', () => ({
    logger: noopLogger,
    uploadLogger: noopLogger,
    downloadLogger: noopLogger,
    storageLogger: noopLogger,
    s3Logger: noopLogger,
}));

// Several other suites in this package replace `src/storage/s3` wholesale with
// `S3Storage: class {}`, and `mock.module` overrides are global for the whole
// `bun test` process. Bun keys its module registry on the full specifier, so
// importing the same file with a query suffix loads the genuine implementation
// regardless of which suite ran first — this file must exercise the real
// getStream, not another suite's stub.
type S3Module = typeof import('../storage/s3');
let S3Storage: S3Module['S3Storage'];

beforeAll(async () => {
    const mod = (await import(`${import.meta.dir}/../storage/s3.ts?real-impl`)) as S3Module;
    S3Storage = mod.S3Storage;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SendFn = (command: unknown) => Promise<unknown>;

/**
 * Build a real S3Storage and swap its S3 client for a stub. The constructor
 * performs no network I/O, so this exercises the actual getStream logic
 * without touching the AWS SDK's transport.
 */
function createStorage(send: SendFn) {
    const store = new S3Storage({
        providerId: 'test-provider',
        bucket: 'test-bucket',
        endpoint: 'https://s3.example.com',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
    });
    (store as unknown as { s3: { send: SendFn } }).s3 = { send };
    return store;
}

function fakeBody(bytes: Uint8Array) {
    return {
        transformToWebStream: () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                },
            }),
    };
}

/** Shape of the error the AWS SDK throws when GetObject hits a missing key. */
function noSuchKeyError() {
    const err = new Error('The specified key does not exist.');
    err.name = 'NoSuchKey';
    Object.assign(err, { Code: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S3Storage.getStream — missing object (#26)', () => {
    let sendCalls: number;

    beforeEach(() => {
        sendCalls = 0;
    });

    it('returns null instead of throwing when the object is gone (NoSuchKey)', async () => {
        const store = createStorage(() => {
            sendCalls++;
            return Promise.reject(noSuchKeyError());
        });

        // Pre-fix this rejected with NoSuchKey, which escaped the route as a 500
        // and made the routes' `if (!stream) -> 404` branch dead code.
        const stream = await store.getStream('missing-id');

        expect(stream).toBeNull();
        expect(sendCalls).toBe(1);
    });

    it('returns null for a 404 NotFound error', async () => {
        const store = createStorage(() => {
            const err = new Error('Not Found');
            err.name = 'NotFound';
            Object.assign(err, { $metadata: { httpStatusCode: 404 } });
            return Promise.reject(err);
        });

        expect(await store.getStream('missing-id')).toBeNull();
    });

    it('returns null for an S3-compatible provider that only sets a 404 status', async () => {
        const store = createStorage(() => {
            const err = new Error('not found');
            err.name = 'SomeProviderError';
            Object.assign(err, { $metadata: { httpStatusCode: 404 } });
            return Promise.reject(err);
        });

        expect(await store.getStream('missing-id')).toBeNull();
    });

    it('still propagates non-404 failures (never masks a broken bucket as 404)', async () => {
        const store = createStorage(() => {
            const err = new Error('Access Denied');
            err.name = 'AccessDenied';
            Object.assign(err, { Code: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
            return Promise.reject(err);
        });

        await expect(store.getStream('some-id')).rejects.toThrow('Access Denied');
    });

    it('propagates NoSuchBucket rather than reporting it as a missing file', async () => {
        const store = createStorage(() => {
            const err = new Error('The specified bucket does not exist');
            err.name = 'NoSuchBucket';
            Object.assign(err, { Code: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
            return Promise.reject(err);
        });

        await expect(store.getStream('some-id')).rejects.toThrow(
            'The specified bucket does not exist',
        );
    });
});

describe('S3Storage.getStream — ContentLength passthrough (#39)', () => {
    it('tags the returned stream with the GetObject ContentLength', async () => {
        const store = createStorage(async () => ({
            Body: fakeBody(new Uint8Array([1, 2, 3])),
            ContentLength: 3,
        }));

        const stream = await store.getStream('abc123');

        expect(stream).not.toBeNull();
        // Pre-fix ContentLength was discarded entirely, so this was undefined
        // and the routes emitted a chunked response with no Content-Length.
        expect(stream?.contentLength).toBe(3);
    });

    it('tags a zero-byte object with contentLength 0 (not undefined)', async () => {
        const store = createStorage(async () => ({
            Body: fakeBody(new Uint8Array([])),
            ContentLength: 0,
        }));

        const stream = await store.getStream('empty');

        expect(stream?.contentLength).toBe(0);
    });

    it('leaves contentLength undefined when S3 omits ContentLength', async () => {
        const store = createStorage(async () => ({
            Body: fakeBody(new Uint8Array([1, 2, 3])),
        }));

        const stream = await store.getStream('abc123');

        expect(stream).not.toBeNull();
        expect(stream?.contentLength).toBeUndefined();
    });

    it('still returns a usable stream body', async () => {
        const store = createStorage(async () => ({
            Body: fakeBody(new Uint8Array([7, 8, 9])),
            ContentLength: 3,
        }));

        const stream = await store.getStream('abc123');
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();

        expect(Array.from(first.value ?? [])).toEqual([7, 8, 9]);
    });

    it('returns null when the response carries no body', async () => {
        const store = createStorage(async () => ({ ContentLength: 10 }));

        expect(await store.getStream('abc123')).toBeNull();
    });
});
