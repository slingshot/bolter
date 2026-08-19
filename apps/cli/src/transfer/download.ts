/**
 * The download engine.
 *
 * The browser can only resume a download sequentially — `Range: bytes=N-` from
 * wherever it got to. A filesystem client can do better: pre-signed GET URLs
 * support ranges, so the object is fetched as many independent ranges written
 * into a sparse file at their own offsets. Nothing is buffered and nothing is
 * ordered.
 *
 * Encryption does not get in the way of that, for the same reason it does not
 * on the upload side: an ECE record's nonce is derived from its index, so a
 * range that starts on a record boundary decrypts on its own given the right
 * starting counter. Ranges are cut on record boundaries and each is decrypted
 * as it lands, straight to its plaintext offset.
 */

import { open, rename, unlink } from 'node:fs/promises';
import {
    type BolterClient,
    createDecryptionStream,
    ECE_ENCRYPTED_RECORD_SIZE,
    ECE_RECORD_SIZE,
    isRetryableError,
    type Keychain,
    readEceVersion,
    retryDelayMs,
    type UploadMetadata,
} from '@bolter/protocol';
import { SendfmError } from '../core/errors';

/** Ciphertext bytes per ranged request, before record alignment. */
const TARGET_RANGE_BYTES = 8 * 1024 * 1024;

const MAX_RANGE_ATTEMPTS = 6;

/** No bytes for this long and the connection is wedged rather than slow. */
const RANGE_STALL_MS = 60_000;

export interface DownloadProgress {
    received: number;
    total: number;
    ranges: number;
    rangesDone: number;
    retries: number;
    rate: number;
    eta: number | null;
}

export interface DownloadOptions {
    client: BolterClient;
    id: string;
    keychain: Keychain | null;
    metadata: UploadMetadata;
    /** Ciphertext size as stored — what the ranged requests cover. */
    storedSize: number;
    destination: string;
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadOutcome {
    path: string;
    bytes: number;
    ranges: number;
    retries: number;
}

export interface RangeSpec {
    index: number;
    /** Byte range in the stored object. */
    start: number;
    end: number;
    /** Offset in the output file where this range's plaintext belongs. */
    outputOffset: number;
    /** Record counter this range starts at; 0 when not encrypted. */
    recordIndex: number;
    /** True for the range that contains the end of the object. */
    last: boolean;
}

/**
 * Cut the object into ranges.
 *
 * Encrypted ranges are aligned to whole ECE records, which is what makes each
 * one independently decryptable. Unencrypted ranges have no such constraint,
 * so they are cut at the target size exactly.
 */
export function planRanges(storedSize: number, encrypted: boolean): RangeSpec[] {
    if (storedSize === 0) {
        return [];
    }
    const step = encrypted
        ? Math.max(1, Math.floor(TARGET_RANGE_BYTES / ECE_ENCRYPTED_RECORD_SIZE)) *
          ECE_ENCRYPTED_RECORD_SIZE
        : TARGET_RANGE_BYTES;

    const ranges: RangeSpec[] = [];
    for (let start = 0, index = 0; start < storedSize; start += step, index++) {
        const end = Math.min(start + step, storedSize);
        const recordIndex = encrypted ? start / ECE_ENCRYPTED_RECORD_SIZE : 0;
        ranges.push({
            index,
            start,
            end,
            outputOffset: encrypted ? recordIndex * ECE_RECORD_SIZE : start,
            recordIndex,
            last: end >= storedSize,
        });
    }
    return ranges;
}

/** Fetch one range, verifying the server honoured it. */
async function fetchRange(
    url: string,
    range: RangeSpec,
    signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(url, {
        headers: { Range: `bytes=${range.start}-${range.end - 1}` },
        signal,
    });

    if (!response.ok) {
        await response.body?.cancel().catch(() => {
            // Already closed by the peer.
        });
        throw new Error(`HTTP ${response.status}`);
    }
    if (response.status !== 206) {
        // A 200 means the server ignored the Range header and is sending the
        // whole object. Writing it at this range's offset would corrupt the
        // file, so refuse rather than guess.
        await response.body?.cancel().catch(() => {
            // Already closed.
        });
        throw new SendfmError(
            'DOWNLOAD_FAILED',
            'Storage ignored a Range request, so this file cannot be fetched in parallel',
            { hint: 'Retry with --concurrency 1.' },
        );
    }
    if (!response.body) {
        throw new Error('HTTP 200 with no body');
    }
    return response.body;
}

export async function downloadToFile(options: DownloadOptions): Promise<DownloadOutcome> {
    const signal = options.signal ?? new AbortController().signal;
    const encrypted = Boolean(options.keychain);
    const ranges = planRanges(options.storedSize, encrypted);
    const eceVersion = readEceVersion(options.metadata);

    // Written to a sibling temp file and renamed at the end: a partial file
    // that looks like the real one is worse than no file at all, and the
    // rename is what makes "downloaded" atomic.
    const temporary = `${options.destination}.part`;
    const handle = await open(temporary, 'w');

    let received = 0;
    let written = 0;
    let rangesDone = 0;
    let retries = 0;
    const started = Date.now();

    const report = () => {
        const elapsed = (Date.now() - started) / 1000;
        const rate = elapsed > 0 ? received / elapsed : 0;
        options.onProgress?.({
            received,
            total: options.storedSize,
            ranges: ranges.length,
            rangesDone,
            retries,
            rate,
            eta: rate > 0 ? Math.max(0, (options.storedSize - received) / rate) : null,
        });
    };

    const runRange = async (range: RangeSpec, url: string): Promise<void> => {
        const body = await fetchRange(url, range, AbortSignal.any([signal, timeoutFor(range)]));

        const plaintext = options.keychain
            ? body.pipeThrough(
                  createDecryptionStream(options.keychain, {
                      eceVersion,
                      initialCounter: range.recordIndex,
                      // Only the last range contains the final-flagged record;
                      // demanding one from a middle range would fail every
                      // parallel download.
                      expectFinalRecord: range.last,
                  }),
              )
            : body;

        let at = range.outputOffset;
        const reader = plaintext.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            await handle.write(value, 0, value.length, at);
            at += value.length;
            written += value.length;
            // Progress tracks stored bytes so the bar matches the transfer,
            // not the (larger or smaller) decrypted output.
            received = Math.min(options.storedSize, received + value.length);
            report();
        }
    };

    try {
        const url = await resolveUrl(options);
        const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
        let next = 0;
        let failure: unknown;

        await new Promise<void>((resolve, reject) => {
            let active = 0;
            const pump = (): void => {
                if (failure !== undefined) {
                    if (active === 0) {
                        reject(failure);
                    }
                    return;
                }
                if (next >= ranges.length && active === 0) {
                    resolve();
                    return;
                }
                while (active < concurrency && next < ranges.length) {
                    const range = ranges[next++];
                    active++;
                    withRangeRetries(range, url, runRange, options, () => {
                        retries++;
                    })
                        .then(() => {
                            rangesDone++;
                            report();
                        })
                        .catch((error: unknown) => {
                            failure ??= error;
                        })
                        .finally(() => {
                            active--;
                            pump();
                        });
                }
            };
            pump();
        });

        // Truncation has to fail loudly. A short file that looks complete is
        // the one outcome worse than an error, and the ECE final record only
        // catches truncation at a record boundary.
        const expected = expectedPlaintextSize(options);
        if (expected !== null && written !== expected) {
            throw new SendfmError(
                'DOWNLOAD_FAILED',
                `Expected ${expected} bytes but wrote ${written} — the download was incomplete`,
            );
        }

        // Durable before it is visible, and visible before the download is
        // reported: the counter must never be spent on a file that was not saved.
        await handle.sync();
        await handle.close();
        await rename(temporary, options.destination);

        return { path: options.destination, bytes: written, ranges: ranges.length, retries };
    } catch (error) {
        await handle.close().catch(() => {
            // Already closed on the success path.
        });
        await unlink(temporary).catch(() => {
            // Never existed, or already gone.
        });
        throw error;
    }
}

function timeoutFor(range: RangeSpec): AbortSignal {
    // Scaled by size so a large range on a slow link is not mistaken for a
    // wedged one; the floor is what catches a socket that never speaks.
    return AbortSignal.timeout(RANGE_STALL_MS + (range.end - range.start) / 1024);
}

async function withRangeRetries(
    range: RangeSpec,
    url: string,
    run: (range: RangeSpec, url: string) => Promise<void>,
    options: DownloadOptions,
    onRetry: () => void,
): Promise<void> {
    let current = url;
    let lastError: unknown;
    for (let i = 0; i < MAX_RANGE_ATTEMPTS; i++) {
        options.signal?.throwIfAborted();
        try {
            await run(range, current);
            return;
        } catch (error) {
            lastError = error;
            if (error instanceof SendfmError && !error.retryable) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('HTTP 403')) {
                // The signed URL expired mid-download, which a long transfer
                // makes likely rather than exceptional.
                current = await resolveUrl(options);
                continue;
            }
            if (!isRetryableError(error as Error)) {
                throw error;
            }
            onRetry();
            await Bun.sleep(retryDelayMs(i));
        }
    }
    throw new SendfmError(
        'DOWNLOAD_FAILED',
        `Range ${range.start}-${range.end} failed after ${MAX_RANGE_ATTEMPTS} attempts`,
        { cause: lastError, retryable: true },
    );
}

async function resolveUrl(options: DownloadOptions): Promise<string> {
    const status = await options.client.getDownloadUrl(options.id, options.keychain);
    if (status.status === 'gone') {
        throw new SendfmError('GONE', 'That link is no longer available.');
    }
    if (status.status === 'error') {
        throw new SendfmError('NETWORK', 'Could not reach the instance.', { retryable: true });
    }
    if (!status.url) {
        throw new SendfmError('GONE', 'That file has used up its downloads.', {
            details: { dl: status.dl, dlimit: status.dlimit },
        });
    }
    return status.url;
}

/**
 * How many plaintext bytes the output should end up with.
 *
 * Taken from the metadata rather than the transfer, so it is an independent
 * check. Null when the metadata cannot say — a legacy multi-file share, for
 * instance — in which case the ECE final record is the only guard available.
 */
function expectedPlaintextSize(options: DownloadOptions): number | null {
    const files = options.metadata.files ?? [];
    if (options.metadata.zipped || files.length !== 1) {
        return null;
    }
    return files[0].size;
}
