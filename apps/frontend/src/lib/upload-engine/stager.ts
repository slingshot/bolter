/**
 * Rolling-window stager for the worker upload engine.
 *
 * Pipes a byte producer (optionally through the ECE encryption transform) and
 * cuts the payload at `partSize` boundaries into `PartStore.stagePart` calls.
 * The final allocated part absorbs all overflow bytes (iOS lazy-transcode
 * growth [R1]) — guarded by the S3/R2 5 GiB per-part cap: growth past the cap
 * fails fast with a clear, non-retryable error instead of staging and
 * shipping >5 GiB only for the bucket to reject the PUT with EntityTooLarge.
 * A short source simply produces fewer contiguous parts
 * (shrink). After every committed stage the part record and the producer
 * checkpoint are persisted in one transaction — the checkpoint always
 * describes the next part to produce, so a crash between stages resumes from
 * an exact boundary [R4][R5], and no crash can land the part record without
 * it. When `windowSize` unreleased parts accumulate, staging pauses
 * until `partReleased()` reports a freed slot (backpressure). What frees a
 * slot is the consumer's business — the engine frees one when an uploader
 * picks a part up, so the window measures parts staged and *waiting*, not
 * bytes resident on disk.
 *
 * Worker-safe: no DOM globals. For encrypted uploads only ciphertext reaches
 * the part store — the encryption transform runs before any staging write.
 */

import { ECE_ENCRYPTED_RECORD_SIZE, ECE_RECORD_SIZE } from '@bolter/protocol/crypto';
import type { PartStore } from './part-store';
import type { ProducerChunk } from './producer';
import type { EngineStateStore, ProducerCheckpoint } from './state';

/** S3/R2 hard per-part maximum — the legacy pipeline enforces the same cap
 * on its trailing-part drain (`MAX_PART_SIZE`, api.ts). */
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;

export interface StagerOpts {
    fileId: string;
    partSize: number; // payload bytes per part (already effective/record-aligned when encrypted)
    totalParts: number; // allocated part count — hard cap; final part absorbs overflow [R1]
    windowSize: number; // max staged parts outstanding before `partReleased()` gates staging
    /** Test seam for the growth-absorption cap; defaults to the S3/R2 5 GiB
     * per-part limit. */
    maxPartBytes?: number;
    store: PartStore;
    state: EngineStateStore;
    encrypt?: TransformStream<Uint8Array, Uint8Array>; // createEncryptionStream(keychain) when encrypted
    checkpointOf(sourceOffset: number, partNumber: number, eof: boolean): ProducerCheckpoint;
    onPartStaged(partNumber: number, size: number): void; // wakes uploaders
    partReleased: () => Promise<void>; // resolves when a window slot frees
}

export async function runStager(
    producer: AsyncGenerator<ProducerChunk>,
    opts: StagerOpts,
): Promise<{ partsProduced: number; actualSize: number }> {
    const { partSize, totalParts, windowSize } = opts;
    const maxPartBytes = opts.maxPartBytes ?? MAX_PART_SIZE;
    if (!Number.isInteger(partSize) || partSize <= 0) {
        throw new Error(`partSize must be a positive integer, got ${partSize}`);
    }
    if (!Number.isInteger(maxPartBytes) || maxPartBytes < partSize) {
        throw new Error(
            `maxPartBytes must be an integer >= partSize (${partSize}), got ${maxPartBytes}`,
        );
    }
    if (!Number.isInteger(totalParts) || totalParts <= 0) {
        throw new Error(`totalParts must be a positive integer, got ${totalParts}`);
    }
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
        throw new Error(`windowSize must be a positive integer, got ${windowSize}`);
    }
    if (opts.encrypt && partSize % ECE_ENCRYPTED_RECORD_SIZE !== 0) {
        throw new Error(
            `encrypted partSize must be a multiple of ${ECE_ENCRYPTED_RECORD_SIZE}, got ${partSize}`,
        );
    }

    // Plaintext bytes pulled from the producer — the source-domain offset for
    // checkpoints once EOF is reached.
    let plaintextConsumed = 0;
    const onPlaintext = (byteLength: number) => {
        plaintextConsumed += byteLength;
    };
    const payload = opts.encrypt
        ? encryptedPayload(producer, opts.encrypt, onPlaintext)
        : plainPayload(producer, onPlaintext);

    let pending: Uint8Array | undefined;
    let sawEof = false;

    /** Next non-empty payload chunk, or null at EOF. */
    const pullChunk = async (): Promise<Uint8Array | null> => {
        if (pending) {
            const chunk = pending;
            pending = undefined;
            return chunk;
        }
        while (!sawEof) {
            const { done, value } = await payload.next();
            if (done) {
                sawEof = true;
                break;
            }
            if (value.byteLength > 0) {
                return value;
            }
        }
        return null;
    };

    /** Feed `stagePart` up to `limit` payload bytes, splitting at the boundary. */
    async function* partChunks(limit: number): AsyncGenerator<Uint8Array> {
        let emitted = 0;
        while (emitted < limit) {
            const chunk = await pullChunk();
            if (chunk === null) {
                return;
            }
            const room = limit - emitted;
            if (chunk.byteLength > room) {
                pending = chunk.subarray(room);
                emitted += room;
                yield chunk.subarray(0, room);
            } else {
                emitted += chunk.byteLength;
                yield chunk;
            }
        }
    }

    let partsProduced = 0;
    let actualSize = 0;
    let inWindow = 0;

    /**
     * Source-domain (plaintext) offset for the checkpoint written after a part
     * commits. At EOF the whole source has been consumed and counted. At a
     * non-final boundary the staged payload is an exact multiple of the
     * encrypted record size, and each encrypted record covers
     * `ECE_RECORD_SIZE` plaintext bytes.
     */
    const sourceOffsetAt = (eof: boolean): number => {
        if (eof) {
            return plaintextConsumed;
        }
        if (!opts.encrypt) {
            return actualSize;
        }
        return (actualSize / ECE_ENCRYPTED_RECORD_SIZE) * ECE_RECORD_SIZE;
    };

    try {
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
            // Peek before staging: a source that ended exactly at the previous
            // boundary must not commit an empty part.
            const first = await pullChunk();
            if (first === null) {
                break;
            }
            pending = first;

            while (inWindow >= windowSize) {
                await opts.partReleased();
                inWindow -= 1;
            }

            const isFinalAllocated = partNumber === totalParts;
            // Growth absorption is bounded by the S3/R2 per-part cap [R1]:
            // a final part the bucket would reject must never be staged as
            // complete, let alone transferred.
            const limit = isFinalAllocated ? maxPartBytes : partSize;
            const { size } = await opts.store.stagePart(partNumber, partChunks(limit));
            actualSize += size;

            let eof: boolean;
            if (isFinalAllocated) {
                if (size >= limit) {
                    const overflow = await pullChunk();
                    if (overflow !== null) {
                        // Deliberately non-retryable: the source outgrew what
                        // this allocation can legally ship.
                        throw new Error(
                            `upload grew beyond its allocation: the final part reached the ` +
                                `${limit}-byte S3/R2 per-part limit with source bytes remaining`,
                        );
                    }
                }
                // The final allocated part drains the source (growth
                // absorption).
                eof = true;
            } else if (size < limit) {
                // A short part means the payload ended inside it.
                eof = true;
            } else {
                // Filled exactly to the boundary — peek so a source that ends
                // right here still gets an eof-marked checkpoint.
                const peeked = await pullChunk();
                if (peeked === null) {
                    eof = true;
                } else {
                    pending = peeked;
                    eof = false;
                }
            }

            await opts.state.putPartAndCheckpoint(
                {
                    fileId: opts.fileId,
                    partNumber,
                    size,
                    staged: true,
                    uploaded: false,
                },
                opts.checkpointOf(sourceOffsetAt(eof), partNumber + 1, eof),
            );
            partsProduced += 1;
            inWindow += 1;
            opts.onPartStaged(partNumber, size);

            if (eof) {
                break;
            }
        }
        return { partsProduced, actualSize };
    } finally {
        if (!sawEof) {
            // Error or early stop: release the payload pipeline so the
            // producer (and any encryption pipe) is cancelled. Best-effort —
            // the original error wins.
            await payload.return(undefined).then(
                () => undefined,
                () => undefined,
            );
        }
    }
}

/** Unencrypted payload: producer bytes pass straight through. */
async function* plainPayload(
    producer: AsyncGenerator<ProducerChunk>,
    onPlaintext: (byteLength: number) => void,
): AsyncGenerator<Uint8Array> {
    for await (const chunk of producer) {
        onPlaintext(chunk.bytes.byteLength);
        yield chunk.bytes;
    }
}

/**
 * Encrypted payload: pipe the producer through the ECE transform. The
 * producer is wrapped in a pull-based ReadableStream so `pipeThrough` owns the
 * pumping and backpressure; cancelling the reader propagates back to the
 * producer.
 */
function encryptedPayload(
    producer: AsyncGenerator<ProducerChunk>,
    encrypt: TransformStream<Uint8Array, Uint8Array>,
    onPlaintext: (byteLength: number) => void,
): AsyncGenerator<Uint8Array> {
    const source = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await producer.next();
            if (done) {
                controller.close();
                return;
            }
            onPlaintext(value.bytes.byteLength);
            controller.enqueue(value.bytes);
        },
        async cancel() {
            await producer.return(undefined);
        },
    });
    return streamChunks(source.pipeThrough(encrypt));
}

async function* streamChunks(readable: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = readable.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            yield value;
        }
    } finally {
        // Early exit (cutter error/stop): cancel the pipe so the producer is
        // released. After a clean EOF this resolves immediately.
        await reader.cancel().then(
            () => undefined,
            () => undefined,
        );
    }
}
