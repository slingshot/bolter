/**
 * #51 — the limit-reached TTL cap must be one atomic Redis script.
 *
 * The behavioural proof (an owner `/params` raise interleaved with the cap) is
 * in `routes/download.test.ts`; this file pins the storage-layer contract that
 * makes it possible: a single round trip that re-reads `dl`/`dlimit`, persists
 * `expiresAt`, and applies the EXPIRE without any client-side gap in between.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { RedisStorage } from '../storage/redis';

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

describe('RedisStorage.capTTLAtDownloadLimit (#51)', () => {
    let script: string;

    beforeEach(async () => {
        const { store, calls } = createStorage(() => 1);
        await store.capTTLAtDownloadLimit('file-id', 300);
        script = calls[0].script;
    });

    it('passes the key plus the grace window and a wall-clock reference', async () => {
        const { store, calls } = createStorage(() => 1);
        const before = Math.floor(Date.now() / 1000);

        await store.capTTLAtDownloadLimit('file-id', 300);

        expect(calls.length).toBe(1);
        expect(calls[0].keys).toEqual(['file-id']);
        expect(calls[0].args[0]).toBe('300');
        const now = parseInt(calls[0].args[1], 10);
        expect(now).toBeGreaterThanOrEqual(before);
        expect(now).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    });

    it('reports whether the cap was actually applied', async () => {
        const { store: applied } = createStorage(() => 1);
        expect(await applied.capTTLAtDownloadLimit('file-id', 300)).toBe(true);

        const { store: skipped } = createStorage(() => 0);
        expect(await skipped.capTTLAtDownloadLimit('file-id', 300)).toBe(false);

        // Redis returns nil (null) for a script that returns false
        const { store: nil } = createStorage(() => null);
        expect(await nil.capTTLAtDownloadLimit('file-id', 300)).toBe(false);
    });

    it('re-reads dl and dlimit and bails out when the limit is no longer reached', () => {
        // This is the whole point of #51: an owner /params raise that commits
        // before the cap must prevent the cap, otherwise the metadata expires
        // at 300s while the grace timer keeps the object (orphaned in S3).
        expect(script).toContain("HGET', KEYS[1], 'dl'");
        expect(script).toContain("HGET', KEYS[1], 'dlimit'");
        expect(script).toContain('dl < dlimit then return 0');
        expect(script.indexOf('dl < dlimit')).toBeLessThan(script.indexOf('EXPIRE'));
    });

    it('persists expiresAt before applying the EXPIRE', () => {
        // /params only restores the original TTL when it can read expiresAt, so
        // the write must never trail the EXPIRE.
        expect(script).toContain("HSET', KEYS[1], 'expiresAt'");
        expect(script.indexOf("'HSET'")).toBeLessThan(script.indexOf("'EXPIRE'"));
    });

    it('does not shorten a TTL that is already inside the grace window', () => {
        expect(script).toContain("TTL', KEYS[1]");
        expect(script).toContain('ttl <= grace then return 0');
    });

    it('is EXISTS-guarded so a just-expired key is not resurrected', () => {
        expect(script).toContain('EXISTS');
        expect(script.indexOf('EXISTS')).toBeLessThan(script.indexOf('HSET'));
    });

    it('performs the whole cap in a single round trip', async () => {
        const { store, calls } = createStorage(() => 1);

        await store.capTTLAtDownloadLimit('file-id', 300);

        // A TTL read followed by separate HSET/EXPIRE calls is exactly the
        // non-atomic chain that #51 describes.
        expect(calls.length).toBe(1);
    });
});
