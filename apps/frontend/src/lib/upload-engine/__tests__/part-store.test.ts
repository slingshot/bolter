import { describe, expect, it } from 'vitest';
import { MemoryPartStore, PartStoreQuotaError } from '../part-store';

// biome-ignore lint/suspicious/useAwait: async generator builds the AsyncIterable the PartStore contract requires
async function* chunks(...arrays: Uint8Array[]) {
    for (const a of arrays) {
        yield a;
    }
}

describe('MemoryPartStore', () => {
    it('stages, lists, reads, deletes a part', async () => {
        const s = new MemoryPartStore();
        const { size } = await s.stagePart(1, chunks(new Uint8Array([1, 2]), new Uint8Array([3])));
        expect(size).toBe(3);
        expect(await s.listParts()).toEqual([{ partNumber: 1, size: 3 }]);
        expect(new Uint8Array(await (await s.readPart(1)).arrayBuffer())).toEqual(
            new Uint8Array([1, 2, 3]),
        );
        await s.deletePart(1);
        expect(await s.listParts()).toEqual([]);
    });
    it('an aborted stage leaves no committed part', async () => {
        const s = new MemoryPartStore();
        // biome-ignore lint/suspicious/useAwait: async generator builds the AsyncIterable the PartStore contract requires
        async function* failing() {
            yield new Uint8Array([1]);
            throw new Error('source died');
        }
        await expect(s.stagePart(1, failing())).rejects.toThrow('source died');
        expect(await s.listParts()).toEqual([]);
    });
    it('throws typed quota error and stages nothing', async () => {
        const s = new MemoryPartStore({ quotaBytes: 2 });
        await expect(s.stagePart(1, chunks(new Uint8Array([1, 2, 3])))).rejects.toBeInstanceOf(
            PartStoreQuotaError,
        );
        expect(await s.listParts()).toEqual([]);
    });
    it('re-staging the same part number replaces it', async () => {
        const s = new MemoryPartStore();
        await s.stagePart(1, chunks(new Uint8Array([9])));
        await s.stagePart(1, chunks(new Uint8Array([7, 8])));
        expect(await s.listParts()).toEqual([{ partNumber: 1, size: 2 }]);
    });
});
