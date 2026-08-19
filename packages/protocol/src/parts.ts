/**
 * Part planning: the map between a file's bytes and the multipart parts that
 * carry them.
 *
 * The server decides `partSize` once, at allocation, and it cannot change:
 * R2 rejects a multipart whose non-trailing parts differ in size (error
 * 10048). Every client therefore derives the same plan from the same two
 * inputs, and a client that derives it differently produces an object the
 * others cannot read.
 *
 * The important property, and the one the CLI is built on: **a part's byte
 * range is a pure function of its part number.** Nothing here consults a
 * stream position or a cursor, so any part can be produced at any time, in
 * any order, any number of times — which is what makes a byte-identical
 * retry free on a filesystem, with no staged copy.
 */

import { UPLOAD_LIMITS } from '@bolter/shared';
import { ECE_ENCRYPTED_RECORD_SIZE, ECE_RECORD_SIZE } from './crypto';

/**
 * Part size actually used when cutting a stream into parts.
 *
 * Encrypted parts are cut on ECE record boundaries so every non-trailing part
 * holds a whole number of records — required so a resumed upload can
 * re-encrypt the remainder with a consistent record counter. The backend
 * allocates parts from the raw `partSize`; because the effective size is
 * never larger, the last allocated part absorbs the residual bytes.
 */
export function getEffectivePartSize(partSize: number, encrypted: boolean): number {
    if (!encrypted) {
        return partSize;
    }
    return Math.floor(partSize / ECE_ENCRYPTED_RECORD_SIZE) * ECE_ENCRYPTED_RECORD_SIZE;
}

export interface PartPlanEntry {
    partNumber: number;
    /** Offset of this part's first byte in the uploaded (post-encryption) stream. */
    start: number;
    /** Offset one past this part's last byte in the uploaded stream. */
    end: number;
    size: number;
    /** True for the final allocated part, which absorbs all remaining bytes. */
    isTrailing: boolean;
}

export interface PartPlan {
    partSize: number;
    effectivePartSize: number;
    totalSize: number;
    encrypted: boolean;
    parts: PartPlanEntry[];
}

/**
 * Build the full part plan for an upload.
 *
 * `totalSize` is the size of the bytes that will actually be PUT — i.e. the
 * ciphertext size for an encrypted upload, which `calculateEncryptedSize`
 * gives exactly. `numParts` is what the server allocated; parts `1..n-1` are
 * exactly `effectivePartSize` and part `n` takes whatever is left, matching
 * the allocation the backend signed URLs for.
 */
export function planParts(opts: {
    totalSize: number;
    partSize: number;
    numParts: number;
    encrypted: boolean;
}): PartPlan {
    const { totalSize, partSize, numParts, encrypted } = opts;
    if (numParts < 1) {
        throw new Error(`part plan invalid: numParts must be >= 1, got ${numParts}`);
    }
    // A single part is always the trailing one, so it takes everything and no
    // alignment applies. Without this, encrypting anything smaller than one
    // ECE record would fail the check below for a constraint that does not
    // exist in that case.
    if (numParts === 1) {
        return {
            partSize,
            effectivePartSize: totalSize,
            totalSize,
            encrypted,
            parts: [
                {
                    partNumber: 1,
                    start: 0,
                    end: totalSize,
                    size: totalSize,
                    isTrailing: true,
                },
            ],
        };
    }

    const effectivePartSize = getEffectivePartSize(partSize, encrypted);
    if (effectivePartSize < 1) {
        throw new Error(
            `part plan invalid: part size ${partSize} is smaller than one ECE record ` +
                `(${ECE_ENCRYPTED_RECORD_SIZE} bytes)`,
        );
    }

    const parts: PartPlanEntry[] = [];
    for (let partNumber = 1; partNumber <= numParts; partNumber++) {
        const start = (partNumber - 1) * effectivePartSize;
        if (start >= totalSize && partNumber > 1) {
            // Defensive: `effectivePartSize <= partSize` means the plan never
            // runs out of bytes before it runs out of allocated parts. Guarding
            // anyway, because the alternative to noticing is a zero-byte part.
            break;
        }
        const last = partNumber === numParts;
        // The trailing part takes everything left: cutting at the effective
        // size leaves a residual of `partSize - effectivePartSize` per part,
        // and it accumulates into the last one. At 1 TB with 128 MiB parts
        // that is ~229 MB of residual, so the trailing part ends up larger
        // than `partSize` rather than smaller.
        const end = last ? totalSize : Math.min(start + effectivePartSize, totalSize);
        parts.push({ partNumber, start, end, size: end - start, isTrailing: false });
    }

    // Derived from position, not from the allocated count: a part that is last
    // in the plan but not numbered `numParts` must still be finalized, or the
    // ciphertext ends with no final-flagged record and cannot be decrypted.
    const trailing = parts.length > 0 ? parts[parts.length - 1] : undefined;
    if (trailing) {
        trailing.isTrailing = true;
        trailing.end = totalSize;
        trailing.size = trailing.end - trailing.start;
    }

    return { partSize, effectivePartSize, totalSize, encrypted, parts };
}

/**
 * Plaintext byte range that produces a given encrypted part.
 *
 * Only meaningful because `effectivePartSize` is a whole number of encrypted
 * records: the record index at a part boundary is exact, so the plaintext
 * offset is too. This is what lets an encrypted part be regenerated on demand
 * from the source file rather than staged to disk.
 */
export function plaintextRangeForPart(
    part: PartPlanEntry,
    plaintextSize: number,
): { start: number; end: number; recordIndex: number } {
    if (part.start % ECE_ENCRYPTED_RECORD_SIZE !== 0) {
        throw new Error(
            `part ${part.partNumber} starts at ciphertext offset ${part.start}, ` +
                `which is not an ECE record boundary (${ECE_ENCRYPTED_RECORD_SIZE})`,
        );
    }
    const recordIndex = part.start / ECE_ENCRYPTED_RECORD_SIZE;
    const start = recordIndex * ECE_RECORD_SIZE;
    const recordsInPart = Math.ceil((part.end - part.start) / ECE_ENCRYPTED_RECORD_SIZE);
    const end = part.isTrailing
        ? plaintextSize
        : Math.min(start + recordsInPart * ECE_RECORD_SIZE, plaintextSize);
    return { start, end, recordIndex };
}

/**
 * Throws an Error whose message starts with `part sequence invalid` unless:
 * part numbers are exactly `1..k`; every part below `k` has
 * `size === effectivePartSize` and at least `MIN_PART_SIZE` (5,242,880)
 * bytes; part `k` may be any size >= 1, including above the effective size.
 *
 * S3 would otherwise assemble a silently corrupt object from a gapped or
 * mis-sized sequence, and R2 rejects an undersized non-trailing part only
 * after every byte has already transferred.
 */
export function validatePartSequence(
    parts: { partNumber: number; size: number }[],
    effectivePartSize: number,
): void {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const k = sorted.length;
    if (k === 0) {
        throw new Error('part sequence invalid: no parts');
    }
    for (let i = 0; i < k; i++) {
        const { partNumber } = sorted[i];
        if (partNumber !== i + 1) {
            throw new Error(
                `part sequence invalid: expected part ${i + 1}, got part ${partNumber} ` +
                    `(parts must be contiguous 1..${k})`,
            );
        }
    }
    for (const { partNumber, size } of sorted) {
        if (partNumber < k) {
            if (size !== effectivePartSize) {
                throw new Error(
                    `part sequence invalid: non-trailing part ${partNumber} is ${size} bytes, ` +
                        `expected exactly ${effectivePartSize}`,
                );
            }
            if (size < UPLOAD_LIMITS.MIN_PART_SIZE) {
                throw new Error(
                    `part sequence invalid: non-trailing part ${partNumber} is ${size} bytes, ` +
                        `below the ${UPLOAD_LIMITS.MIN_PART_SIZE}-byte S3/R2 minimum`,
                );
            }
        } else if (size < 1) {
            throw new Error(`part sequence invalid: trailing part ${partNumber} is empty`);
        }
    }
}
