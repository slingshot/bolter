import { describe, expect, it } from 'bun:test';
import {
    calculateEncryptedSize,
    createEncryptionStream,
    ECE_ENCRYPTED_RECORD_SIZE,
    ECE_RECORD_SIZE,
    Keychain,
} from '../src/crypto';
import {
    getEffectivePartSize,
    plaintextRangeForPart,
    planParts,
    validatePartSequence,
} from '../src/parts';

async function collect(
    data: Uint8Array,
    transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
    const readable = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        },
    }).pipeThrough(transform);

    const chunks: Uint8Array[] = [];
    const reader = readable.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 251);

describe('getEffectivePartSize', () => {
    it('passes the raw size through when unencrypted', () => {
        expect(getEffectivePartSize(64 * 1024 * 1024, false)).toBe(64 * 1024 * 1024);
    });

    it('floors to a whole number of encrypted records when encrypted', () => {
        const effective = getEffectivePartSize(64 * 1024 * 1024, true);
        expect(effective % ECE_ENCRYPTED_RECORD_SIZE).toBe(0);
        expect(effective).toBeLessThanOrEqual(64 * 1024 * 1024);
        expect(effective).toBeGreaterThan(64 * 1024 * 1024 - ECE_ENCRYPTED_RECORD_SIZE);
    });
});

describe('planParts', () => {
    it('covers the whole object with no gaps or overlaps', () => {
        const plan = planParts({
            totalSize: 700_000_000,
            partSize: 64 * 1024 * 1024,
            numParts: 11,
            encrypted: false,
        });
        expect(plan.parts[0].start).toBe(0);
        expect(plan.parts[plan.parts.length - 1]?.end).toBe(700_000_000);
        for (let i = 1; i < plan.parts.length; i++) {
            expect(plan.parts[i].start).toBe(plan.parts[i - 1].end);
        }
        expect(plan.parts.reduce((n, p) => n + p.size, 0)).toBe(700_000_000);
    });

    it('produces a sequence the completion validator accepts', () => {
        const partSize = 64 * 1024 * 1024;
        const totalSize = 700_000_000;
        const plan = planParts({ totalSize, partSize, numParts: 11, encrypted: false });
        expect(() =>
            validatePartSequence(
                plan.parts.map(({ partNumber, size }) => ({ partNumber, size })),
                plan.effectivePartSize,
            ),
        ).not.toThrow();
    });

    it('starts every encrypted part on an ECE record boundary', () => {
        const plan = planParts({
            totalSize: calculateEncryptedSize(5_000_000_000),
            partSize: 64 * 1024 * 1024,
            numParts: 76,
            encrypted: true,
        });
        for (const part of plan.parts) {
            expect(part.start % ECE_ENCRYPTED_RECORD_SIZE).toBe(0);
        }
    });

    /**
     * Two regimes, and the difference matters: cutting at the effective size
     * leaves `partSize - effectivePartSize` unused per part, which accumulates
     * into the trailing part. On a small file that residual is dwarfed by the
     * last part's natural shortfall; on a 1 TB upload it is ~229 MB, and the
     * trailing part ends up *larger* than `partSize`.
     */
    it.each([
        ['1 GB at 64 MiB parts: trailing is short', 1_000_000_000, 64 * 1024 * 1024, 'shorter'],
        ['1 TB at 128 MiB parts: trailing absorbs residual', 1e12, 128 * 1024 * 1024, 'longer'],
    ])('%s', (_name, plaintextSize, partSize, shape) => {
        const totalSize = calculateEncryptedSize(plaintextSize);
        const numParts = Math.ceil(totalSize / partSize);
        const plan = planParts({ totalSize, partSize, numParts, encrypted: true });
        const trailing = plan.parts[plan.parts.length - 1];

        expect(trailing?.end).toBe(totalSize);
        expect(trailing?.isTrailing).toBe(true);
        expect(plan.parts.reduce((n, p) => n + p.size, 0)).toBe(totalSize);
        if (shape === 'longer') {
            expect(trailing?.size).toBeGreaterThan(partSize);
        } else {
            expect(trailing?.size).toBeLessThan(plan.effectivePartSize);
        }
    });

    it('marks the last planned part trailing even if it is not the last allocated one', () => {
        // A short object against a generous allocation: the plan stops early,
        // and the part it stops on is the one that must carry the final record.
        const plan = planParts({
            totalSize: 300_000,
            partSize: 200_000,
            numParts: 9,
            encrypted: true,
        });
        expect(plan.parts.length).toBeLessThan(9);
        expect(plan.parts[plan.parts.length - 1]?.isTrailing).toBe(true);
        expect(plan.parts[plan.parts.length - 1]?.end).toBe(300_000);
    });

    it('rejects a part size below one encrypted record', () => {
        expect(() =>
            planParts({ totalSize: 1000, partSize: 1000, numParts: 1, encrypted: true }),
        ).toThrow(/smaller than one ECE record/);
    });
});

describe('plaintextRangeForPart', () => {
    it('tiles the plaintext exactly', () => {
        const plaintextSize = 10 * ECE_RECORD_SIZE + 1000;
        const totalSize = calculateEncryptedSize(plaintextSize);
        const partSize = 200_000;
        const numParts = Math.ceil(totalSize / partSize);
        const plan = planParts({ totalSize, partSize, numParts, encrypted: true });

        let expectedStart = 0;
        for (const part of plan.parts) {
            const range = plaintextRangeForPart(part, plaintextSize);
            expect(range.start).toBe(expectedStart);
            expectedStart = range.end;
        }
        expect(expectedStart).toBe(plaintextSize);
    });
});

/**
 * The property the whole filesystem-native design rests on: a part's
 * ciphertext depends only on its part number, so any part can be produced at
 * any time, in any order, without a staged copy — and the concatenation is
 * indistinguishable from encrypting the file in one pass.
 *
 * If this ever fails, resumed and retried uploads produce objects that
 * decrypt to garbage, so it is worth its runtime.
 */
describe('per-part regeneration is byte-identical to whole-stream encryption', () => {
    it.each([
        ['exact record multiple', 10 * ECE_RECORD_SIZE],
        ['partial trailing record', 10 * ECE_RECORD_SIZE + 1000],
        ['smaller than one record', 5000],
    ])('%s', async (_name, plaintextSize) => {
        const secret = new Uint8Array(16).fill(3);
        const plaintext = pattern(plaintextSize);

        const whole = await collect(plaintext, createEncryptionStream(new Keychain(secret)));
        expect(whole.length).toBe(calculateEncryptedSize(plaintextSize));

        const partSize = 200_000;
        const numParts = Math.ceil(whole.length / partSize);
        const plan = planParts({
            totalSize: whole.length,
            partSize,
            numParts,
            encrypted: true,
        });

        const rebuilt = new Uint8Array(whole.length);
        for (const part of plan.parts) {
            const range = plaintextRangeForPart(part, plaintextSize);
            const slice = plaintext.slice(range.start, range.end);
            const bytes = await collect(
                slice,
                createEncryptionStream(new Keychain(secret), {
                    initialCounter: range.recordIndex,
                    finalize: part.isTrailing,
                }),
            );
            expect(bytes.length).toBe(part.size);
            rebuilt.set(bytes, part.start);
        }

        expect(rebuilt).toEqual(whole);
    });
});

describe('non-final encryption stream', () => {
    it('refuses to end mid-record, because that part could never be rejoined', async () => {
        const kc = new Keychain(new Uint8Array(16).fill(9));
        await expect(
            collect(
                pattern(ECE_RECORD_SIZE + 10),
                createEncryptionStream(kc, { initialCounter: 0, finalize: false }),
            ),
        ).rejects.toThrow(/ended mid-record/);
    });
});
