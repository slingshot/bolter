/**
 * The upload engine.
 *
 * The whole design rests on one property established in `@bolter/protocol`: a
 * part's bytes are a pure function of its part number. Nothing here holds a
 * cursor, stages a copy, or buffers a part — it asks the source for a byte
 * range, encrypts it if needed, and streams it straight into the request. A
 * retry asks for the same range again and gets identical bytes.
 *
 * The transport is `fetch` with a `ReadableStream` body **and an explicit
 * `Content-Length`**. That header is load-bearing: without it Bun frames the
 * body as `transfer-encoding: chunked`, which S3 and R2 reject on a pre-signed
 * PUT (they are signed UNSIGNED-PAYLOAD). With it, the same stream is framed
 * as a sized body, and `ReadableStream`'s pull contract supplies backpressure —
 * measured at ~5.5 MiB outstanding for a 128 MiB part, so memory tracks the
 * socket buffer rather than the part size.
 */

import {
    type BolterClient,
    buildUploadMetadata,
    type CompletedPart,
    type ConcurrencyController,
    calculateEncryptedSize,
    createConcurrencyController,
    createEncryptionStream,
    encodeMetadata,
    isPushbackError,
    isRetryableError,
    type Keychain,
    type PartPlan,
    type PartPlanEntry,
    plaintextRangeForPart,
    planParts,
    retryDelayMs,
    type UploadUrlResponse,
    validatePartSequence,
} from '@bolter/protocol';
import { UPLOAD_LIMITS } from '@bolter/shared';
import { SendfmError } from '../core/errors';
import type { Source } from './source';

/** Attempts per part before the whole upload gives up. */
const MAX_PART_ATTEMPTS = 8;

/** No bytes for this long means the connection is wedged, not slow. */
const STALL_TIMEOUT_MS = 60_000;

const { MIN_PART_SIZE } = UPLOAD_LIMITS;

export interface UploadProgress {
    /** Bytes handed to the transport so far. */
    uploaded: number;
    total: number;
    partsDone: number;
    partsTotal: number;
    inFlight: number;
    concurrency: number;
    retries: number;
    /** Bytes per second, or 0 before the first sample. */
    rate: number;
    /** Seconds remaining, or null when there is no basis for an estimate. */
    eta: number | null;
}

export interface UploadOptions {
    source: Source;
    client: BolterClient;
    keychain: Keychain | null;
    timeLimit?: number;
    downloadLimit?: number;
    /** Upper bound on the uploader pool. AIMD chooses within it. */
    maxConcurrency?: number;
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
    /**
     * Called once the server has issued an upload, before a byte moves.
     *
     * This is the moment a crash first has something worth recovering: the id,
     * the tokens and the part plan exist, and nothing else can reconstruct
     * them.
     */
    onAllocated?: (allocation: AllocationInfo) => void;
    /** Called after each part is durably stored, with its ETag. */
    onPartComplete?: (part: { partNumber: number; etag: string; size: number }) => void;
    /** Parts already uploaded by an earlier attempt, keyed by part number. */
    resumeFrom?: Map<number, { etag: string; size: number }>;
    /**
     * An allocation from a previous run, for a resume.
     *
     * When present, `/upload/url` is not called again — doing so would mint a
     * second file id and orphan everything already stored. Fresh pre-signed
     * URLs for the outstanding parts come from `/upload/multipart/:id/resume`
     * instead, which is exactly what that route is for.
     */
    existing?: AllocationInfo;
}

/**
 * An allocation, from either `/upload/url` or a resume.
 *
 * `totalParts` is separate from `parts.length` because a resume's response
 * lists only the parts the server is still missing, while the part *plan* has
 * to span the whole object.
 */
type ResolvedAllocation = UploadUrlResponse & { totalParts?: number };

export interface AllocationInfo {
    id: string;
    ownerToken: string;
    uploadToken?: string;
    uploadId?: string;
    partSize?: number;
    totalParts?: number;
    /** Size of the bytes to be PUT — ciphertext size when encrypted. */
    uploadSize: number;
}

export interface UploadOutcome {
    id: string;
    ownerToken: string;
    /** Download URL with no fragment; the key never leaves this process. */
    url: string;
    size: number;
    expiresAt?: number;
    ttl?: number;
    parts: number;
    retries: number;
    peakConcurrency: number;
    pushbacks: number;
}

/**
 * The bytes of one part, and their exact length.
 *
 * The length has to be known before the first byte is produced, because the
 * request carries it as a header. For an encrypted part that is not a problem:
 * the plan already says how long the ciphertext is.
 */
export function partBody(
    source: Source,
    part: PartPlanEntry,
    keychain: Keychain | null,
    plaintextSize: number,
    onBytes?: (n: number) => void,
): { stream: ReadableStream<Uint8Array>; length: number } {
    const range = keychain
        ? plaintextRangeForPart(part, plaintextSize)
        : { start: part.start, end: part.end, recordIndex: 0 };

    const iterator = source.read(range.start, range.end)[Symbol.asyncIterator]();
    const plain = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await iterator.next();
            if (done) {
                controller.close();
                return;
            }
            controller.enqueue(value);
        },
        async cancel(reason) {
            await iterator.return?.(reason);
        },
    });

    const body = keychain
        ? plain.pipeThrough(
              createEncryptionStream(keychain, {
                  initialCounter: range.recordIndex,
                  // Only the final part closes the stream. A middle part that
                  // emitted the final-flagged record would claim to be the end
                  // of the file, and the reassembled object would not match a
                  // whole-stream encryption of the same bytes.
                  finalize: part.isTrailing,
              }),
          )
        : plain;

    // Count on the way out so progress reflects bytes actually handed to the
    // socket, not bytes read from disk.
    const counted = onBytes
        ? body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                      onBytes(chunk.length);
                      controller.enqueue(chunk);
                  },
              }),
          )
        : body;

    return { stream: counted, length: part.size };
}

export interface PutResult {
    etag: string;
}

/** One PUT of one part. Throws with an `HTTP <status>` message on failure. */
export async function putPart(
    url: string,
    body: ReadableStream<Uint8Array>,
    length: number,
    signal: AbortSignal,
): Promise<PutResult> {
    const response = await fetch(url, {
        method: 'PUT',
        body,
        headers: {
            // See the module comment: without this the body is framed chunked
            // and the pre-signed PUT is rejected.
            'Content-Length': String(length),
            /**
             * Keep-alive is disabled for part uploads, deliberately.
             *
             * When a server answers a streamed request before draining its
             * body — which S3 does for an expired pre-signed URL, returning
             * 403 immediately — Bun leaves the unsent body queued on that
             * connection. The *next* request to reuse it is then malformed and
             * comes back 400, so the retry that was supposed to recover from
             * the 403 fails for an unrelated reason.
             *
             * Setting this on the retry alone does not help: the poison is
             * consumed by whichever request comes next, whatever headers that
             * one carries. It has to be set on the request that might be
             * rejected, which is all of them.
             *
             * The cost is one connection setup per part. Parts are at least
             * 5 MiB and usually 64-128 MiB, so it is a rounding error against
             * the transfer itself.
             */
            Connection: 'close',
        },
        signal,
        // Required by the fetch spec for a streaming request body.
        duplex: 'half',
    } as RequestInit);

    if (!response.ok) {
        // Drain before throwing. An unread body leaves the connection unusable,
        // and the very next request on it hangs — which is exactly what happens
        // on the retry after S3 rejects an expired pre-signed URL with a 403
        // it returns without reading the request body.
        await response.body?.cancel().catch(() => {
            // Already closed by the peer; nothing to release.
        });
        throw new Error(`HTTP ${response.status}`);
    }
    const etag = response.headers.get('etag');
    if (!etag) {
        // Multipart completion needs every part's ETag. Failing here names the
        // real cause; without it the upload fails at completion, after every
        // byte has already been transferred.
        throw new SendfmError('UPLOAD_FAILED', 'Storage did not return an ETag for a part', {
            hint: "The bucket's CORS policy must expose the ETag header. Run `sendfm doctor --deep`.",
        });
    }
    return { etag };
}

/**
 * The retry policy, shared by every PUT.
 *
 * Distinctions that matter and are easy to collapse: a 403 is an expired
 * pre-signed URL and needs one refresh rather than a retry storm; a 429 or 503
 * is the server asking for less concurrency, and feeds the AIMD controller; a
 * network fault is neither, and is simply retried with backoff.
 */
async function withRetries<T>(opts: {
    label: string;
    signal: AbortSignal;
    controller?: ConcurrencyController;
    onRetry: () => void;
    url?: string;
    refreshUrl?: () => Promise<string>;
    run: (url: string) => Promise<T>;
}): Promise<T> {
    let url = opts.url;
    if (!url) {
        if (!opts.refreshUrl) {
            throw new SendfmError('UPLOAD_FAILED', `No upload URL for ${opts.label}`);
        }
        url = await opts.refreshUrl();
    }

    let lastError: unknown;
    for (let i = 0; i < MAX_PART_ATTEMPTS; i++) {
        opts.signal.throwIfAborted();
        try {
            return await opts.run(url);
        } catch (error) {
            lastError = error;
            if (error instanceof SendfmError && !error.retryable) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('HTTP 403') && opts.refreshUrl) {
                url = await opts.refreshUrl();
                continue;
            }
            if (isPushbackError(error as Error)) {
                opts.controller?.onPushback(Date.now());
            } else if (!isRetryableError(error as Error)) {
                throw error;
            }
            opts.onRetry();
            await Bun.sleep(retryDelayMs(i));
        }
    }
    throw new SendfmError(
        'UPLOAD_FAILED',
        `${opts.label} failed after ${MAX_PART_ATTEMPTS} attempts`,
        { cause: lastError, retryable: true },
    );
}

interface PartOutcome {
    partNumber: number;
    etag: string;
    size: number;
}

/**
 * Run the parts through a pool whose size the AIMD controller decides.
 *
 * Growth is driven by progress rather than a timer, so a stalled or offline
 * run cannot grow itself; shrinking is cooperative — a retiring worker
 * finishes its part rather than aborting, because discarding in-flight bytes
 * to shrink wastes exactly what the pool exists to conserve.
 */
async function runPool(opts: {
    plan: PartPlan;
    urls: Map<number, string>;
    controller: ConcurrencyController;
    signal: AbortSignal;
    upload: (part: PartPlanEntry, url: string) => Promise<PartOutcome>;
    refreshUrl: (partNumber: number) => Promise<string>;
    onRetry: () => void;
}): Promise<PartOutcome[]> {
    const parts = opts.plan.parts;
    const results: PartOutcome[] = [];
    let next = 0;
    let active = 0;
    let failure: unknown;

    const attempt = (part: PartPlanEntry): Promise<PartOutcome> =>
        withRetries({
            label: `Part ${part.partNumber}`,
            signal: opts.signal,
            controller: opts.controller,
            onRetry: opts.onRetry,
            url: opts.urls.get(part.partNumber),
            refreshUrl: () => opts.refreshUrl(part.partNumber),
            run: (url) => opts.upload(part, url),
        });

    await new Promise<void>((resolve, reject) => {
        const pump = (): void => {
            if (failure !== undefined) {
                if (active === 0) {
                    reject(failure);
                }
                return;
            }
            if (next >= parts.length && active === 0) {
                resolve();
                return;
            }
            // Growth and shrink both fall out of this condition: a larger
            // target starts more workers here, a smaller one simply does not
            // replace the ones that finish. Nothing in flight is ever
            // abandoned, because discarding transferred bytes to shrink wastes
            // exactly what the pool exists to conserve.
            while (active < opts.controller.target() && next < parts.length) {
                const part = parts[next++];
                active++;
                attempt(part)
                    .then((outcome) => {
                        results.push(outcome);
                    })
                    .catch((error: unknown) => {
                        failure ??= error;
                    })
                    .finally(() => {
                        active--;
                        opts.controller.tick(Date.now());
                        pump();
                    });
            }
        };
        pump();
    });

    return results;
}

export async function uploadSource(options: UploadOptions): Promise<UploadOutcome> {
    const { source, client, keychain } = options;
    const signal = options.signal ?? new AbortController().signal;
    const plaintextSize = source.plaintextSize;
    const uploadSize = keychain ? calculateEncryptedSize(plaintextSize) : plaintextSize;

    const allocation = await allocate();

    async function allocate(): Promise<ResolvedAllocation> {
        const previous = options.existing;
        if (!previous) {
            const fresh = await client.requestUploadUrl({
                fileSize: uploadSize,
                encrypted: Boolean(keychain),
                timeLimit: options.timeLimit,
                dlimit: options.downloadLimit,
            });
            if (!fresh.useSignedUrl || !fresh.id || !fresh.owner) {
                throw new SendfmError(
                    'UPLOAD_FAILED',
                    'The instance would not issue an upload URL',
                    { details: { error: fresh.error }, retryable: true },
                );
            }
            return fresh;
        }

        if (!previous.uploadId) {
            // A single-part upload has no server-side state to resume; the
            // whole object is one PUT, so it is simply redone.
            const fresh = await client.requestUploadUrl({
                fileSize: uploadSize,
                encrypted: Boolean(keychain),
                timeLimit: options.timeLimit,
                dlimit: options.downloadLimit,
            });
            if (!fresh.useSignedUrl || !fresh.id || !fresh.owner) {
                throw new SendfmError('UPLOAD_FAILED', 'Could not restart that upload', {
                    retryable: true,
                });
            }
            return fresh;
        }

        const done = [...(options.resumeFrom?.keys() ?? [])];
        const refreshed = await client.resumeMultipart(
            previous.id,
            previous.uploadId,
            done,
            previous.uploadToken,
        );
        return {
            useSignedUrl: true,
            multipart: true,
            id: previous.id,
            owner: previous.ownerToken,
            uploadToken: previous.uploadToken,
            uploadId: previous.uploadId,
            partSize: refreshed.partSize,
            // The server returns URLs only for parts it has not got, so the
            // count here is the *remaining* work, not the total.
            parts: refreshed.parts,
            totalParts: refreshed.numParts,
        };
    }

    if (!allocation.useSignedUrl || !allocation.id || !allocation.owner) {
        throw new SendfmError('UPLOAD_FAILED', 'The instance would not issue an upload URL', {
            details: { error: allocation.error },
            retryable: true,
        });
    }

    const id = allocation.id;
    const ownerToken = allocation.owner;
    options.onAllocated?.({
        id,
        ownerToken,
        uploadToken: allocation.uploadToken,
        uploadId: allocation.uploadId,
        partSize: allocation.partSize,
        totalParts: allocation.parts?.length,
        uploadSize,
    });
    let uploaded = 0;
    let retries = 0;
    const started = Date.now();

    const report = (partsDone: number, inFlight: number, concurrency: number) => {
        const elapsed = (Date.now() - started) / 1000;
        const rate = elapsed > 0 ? uploaded / elapsed : 0;
        options.onProgress?.({
            uploaded,
            total: uploadSize,
            partsDone,
            partsTotal: allocation.multipart ? (allocation.parts?.length ?? 1) : 1,
            inFlight,
            concurrency,
            retries,
            rate,
            eta: rate > 0 ? Math.max(0, (uploadSize - uploaded) / rate) : null,
        });
    };

    let parts: CompletedPart[] | undefined;
    let actualSize = uploadSize;
    let peakConcurrency = 1;
    let pushbacks = 0;

    if (allocation.multipart) {
        if (!allocation.parts?.length || !allocation.partSize || !allocation.uploadId) {
            throw new SendfmError('UPLOAD_FAILED', 'Incomplete multipart allocation');
        }
        const plan = planParts({
            totalSize: uploadSize,
            partSize: allocation.partSize,
            // The whole object, not just what is outstanding: a resume's
            // allocation lists only the parts the server is missing, and a plan
            // built from that count would put every boundary in the wrong place.
            numParts: (allocation as { totalParts?: number }).totalParts ?? allocation.parts.length,
            encrypted: Boolean(keychain),
        });
        // Record alignment shrinks the usable part size, and S3/R2 reject a
        // non-trailing part below 5 MiB — but only after every byte has
        // transferred. Real instances allocate 64-128 MiB parts so this never
        // binds; one that got it wrong should say so now, not an hour from now.
        if (keychain && plan.parts.length > 1 && plan.effectivePartSize < MIN_PART_SIZE) {
            throw new SendfmError(
                'UPLOAD_FAILED',
                `This instance allocated ${allocation.partSize}-byte parts, which align down to ` +
                    `${plan.effectivePartSize} bytes of ciphertext — below the ` +
                    `${MIN_PART_SIZE}-byte minimum storage will accept.`,
                { hint: 'Send without --encrypt, or report this to the instance operator.' },
            );
        }

        const urls = new Map(allocation.parts.map((p) => [p.partNumber, p.url]));
        const cap = Math.max(2, Math.min(options.maxConcurrency ?? 8, 16));
        const controller = createConcurrencyController({
            initial: Math.min(4, cap),
            min: 2,
            max: cap,
        });

        // Parts an earlier attempt already stored. Their bytes are on the
        // server; re-sending them would be correct but wasteful, and for a
        // large upload that waste is the entire point of resuming.
        const already = options.resumeFrom ?? new Map();
        const remaining = {
            ...plan,
            parts: plan.parts.filter((part) => !already.has(part.partNumber)),
        };
        for (const part of already.values()) {
            uploaded += part.size;
        }

        let done = already.size;
        const outcomes = await runPool({
            plan: remaining,
            urls,
            controller,
            signal,
            onRetry: () => {
                retries++;
            },
            refreshUrl: async (partNumber) => {
                const refreshed = await client.resumeMultipart(
                    id,
                    allocation.uploadId as string,
                    [...urls.keys()].filter((n) => n !== partNumber),
                    allocation.uploadToken,
                );
                for (const part of refreshed.parts) {
                    urls.set(part.partNumber, part.url);
                }
                const url = urls.get(partNumber);
                if (!url) {
                    throw new SendfmError(
                        'UPLOAD_FAILED',
                        `Could not refresh the URL for part ${partNumber}`,
                        { retryable: true },
                    );
                }
                return url;
            },
            upload: async (part, url) => {
                const { stream, length } = partBody(source, part, keychain, plaintextSize, (n) => {
                    uploaded += n;
                    report(done, 1, controller.target());
                });
                const stall = AbortSignal.timeout(STALL_TIMEOUT_MS + length / 1024);
                const { etag } = await putPart(
                    url,
                    stream,
                    length,
                    AbortSignal.any([signal, stall]),
                );
                done++;
                report(done, 0, controller.target());
                const outcome = { partNumber: part.partNumber, etag, size: part.size };
                options.onPartComplete?.(outcome);
                return outcome;
            },
        });

        peakConcurrency = controller.peak();
        pushbacks = controller.pushbacks();

        const sorted = [
            ...outcomes,
            ...[...already.entries()].map(([partNumber, part]) => ({
                partNumber,
                etag: part.etag,
                size: part.size,
            })),
        ].sort((a, b) => a.partNumber - b.partNumber);
        // Validate before completing: S3 assembles a silently corrupt object
        // from a gapped or mis-sized sequence, and R2 rejects an undersized
        // non-trailing part only after every byte has transferred.
        validatePartSequence(
            sorted.map((p) => ({ partNumber: p.partNumber, size: p.size })),
            plan.effectivePartSize,
        );
        parts = sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));
        actualSize = sorted.reduce((n, p) => n + p.size, 0);
    } else {
        // Single PUT. The plan still describes it, so the encrypted path is
        // the same code as the multipart one.
        const plan = planParts({
            totalSize: uploadSize,
            partSize: uploadSize || 1,
            numParts: 1,
            encrypted: Boolean(keychain),
        });
        if (!allocation.url) {
            throw new SendfmError('UPLOAD_FAILED', 'No upload URL was issued');
        }
        await withRetries({
            label: 'Upload',
            signal,
            onRetry: () => {
                retries++;
            },
            url: allocation.url,
            run: async (url) => {
                // Rebuilt per attempt: a stream can only be consumed once, and
                // the source is addressable precisely so this is free.
                uploaded = 0;
                const { stream, length } = partBody(
                    source,
                    plan.parts[0],
                    keychain,
                    plaintextSize,
                    (n) => {
                        uploaded += n;
                        report(0, 1, 1);
                    },
                );
                await putPart(url, stream, length, signal);
            },
        });
        report(1, 0, 1);
    }

    // Metadata is built here, not by the caller, because it has to describe
    // what was actually uploaded: the archive's member list for a multi-file
    // send, the single file otherwise.
    const metadata = buildUploadMetadata({
        files: source.files,
        encrypted: Boolean(keychain),
        zipFilename: source.archiveFilename,
    });

    const completion = await client.completeUpload({
        id,
        metadata: await encodeMetadata(metadata, keychain),
        ...(keychain ? { authKey: await keychain.authKeyB64() } : {}),
        actualSize,
        ...(parts ? { parts } : {}),
    });

    return {
        id,
        ownerToken,
        // The server decides this URL's origin, which on a split deployment is
        // the web app rather than the API. No fragment: the key never leaves
        // this process, and the caller appends it locally.
        url: completion.url ?? '',
        size: actualSize,
        // Authoritative, because the TTL starts when the upload URL is issued
        // rather than at completion — a long or resumed upload has materially
        // less life left than `timeLimit` suggests.
        expiresAt: completion.expiresAt,
        ttl: completion.ttl,
        parts: parts?.length ?? 1,
        retries,
        peakConcurrency,
        pushbacks,
    };
}
