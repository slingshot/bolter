import { beforeEach, describe, expect, it } from 'bun:test';
import { RedisStorage } from '../storage/redis';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EvalCall {
    script: string;
    keys: string[];
    args: string[];
}

/**
 * Stand in for the node-redis client. RedisStorage.getClient() short-circuits
 * when `client` is already set, so nothing connects.
 */
function createStorage(evalResult: () => unknown) {
    const calls: EvalCall[] = [];
    const store = new RedisStorage();
    (store as unknown as { client: unknown }).client = {
        eval: (script: string, opts: { keys: string[]; arguments: string[] }) => {
            calls.push({ script, keys: opts.keys, args: opts.arguments });
            return Promise.resolve(evalResult());
        },
    };
    return { store, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisStorage.compareAndRotateNonce (#44)', () => {
    let script: string;

    beforeEach(async () => {
        const { store, calls } = createStorage(() => 1);
        await store.compareAndRotateNonce('file-id', 'old-nonce', 'new-nonce');
        script = calls[0].script;
    });

    it('passes the key plus the expected and next nonce, in that order', async () => {
        const { store, calls } = createStorage(() => 1);

        await store.compareAndRotateNonce('file-id', 'old-nonce', 'new-nonce');

        expect(calls.length).toBe(1);
        expect(calls[0].keys).toEqual(['file-id']);
        expect(calls[0].args).toEqual(['old-nonce', 'new-nonce']);
    });

    it('reports success only when the server-side swap actually happened', async () => {
        const { store: swapped } = createStorage(() => 1);
        expect(await swapped.compareAndRotateNonce('file-id', 'old', 'new')).toBe(true);

        const { store: lost } = createStorage(() => 0);
        expect(await lost.compareAndRotateNonce('file-id', 'old', 'new')).toBe(false);

        // Redis returns nil (null) for a script that returns false
        const { store: nil } = createStorage(() => null);
        expect(await nil.compareAndRotateNonce('file-id', 'old', 'new')).toBe(false);
    });

    it('compares the stored nonce against the caller-supplied one before writing', () => {
        // The whole point of #44: a blind HSET (what rotateNonce does) lets two
        // concurrent verifications of the same nonce both "win". The swap must
        // be conditional on the nonce still being the one that was validated.
        expect(script).toContain('HGET');
        expect(script).toContain('ARGV[1]');
        expect(script).toContain('HSET');
        expect(script).toContain('ARGV[2]');
        expect(script.indexOf('HGET')).toBeLessThan(script.indexOf('HSET'));
    });

    it('is EXISTS-guarded so a just-expired key is not resurrected', () => {
        expect(script).toContain('EXISTS');
        expect(script.indexOf('EXISTS')).toBeLessThan(script.indexOf('HSET'));
    });

    it('performs the whole compare-and-swap in a single round trip', async () => {
        const { store, calls } = createStorage(() => 1);

        await store.compareAndRotateNonce('file-id', 'old', 'new');

        // A read followed by a separate write would not be atomic
        expect(calls.length).toBe(1);
    });
});

describe('RedisStorage.rotateNonce (unconditional challenge issuance)', () => {
    it('still exists for issuing a nonce to legacy records that have none', async () => {
        const { store, calls } = createStorage(() => 1);

        expect(await store.rotateNonce('file-id', 'fresh-nonce')).toBe(true);
        expect(calls[0].keys).toEqual(['file-id']);
        expect(calls[0].args).toEqual(['fresh-nonce']);
        expect(calls[0].script).toContain('EXISTS');
    });
});
