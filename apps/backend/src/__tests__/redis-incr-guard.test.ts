/**
 * Audit #7, trigger 3 — a bare HINCRBY *creates* the hash when the key is
 * absent, so a delete or TTL expiry landing between a download route's metadata
 * read and its counter increment resurrected the key as an immortal `{dl:1}`
 * hash: no TTL, no `owner` (undeletable), no `providerId` (mis-routed).
 *
 * The codebase already EXISTS-guards `rotateNonce` and `hSetIfExists` for
 * exactly this reason; the increment was the one write left unguarded.
 */
import { beforeEach, describe, expect, it } from 'bun:test';

// `../storage/redis` is globally replaced by `mock.module` in sibling test files
// and bun's module mocks are process-global and never reset, so a plain static
// import here resolves the real class or a stub depending on readdir order.
// A query-suffixed specifier is a different key from the one the mocks are
// registered against. See src/__isolated_tests__/README.md.
const REAL_REDIS_MODULE = '../storage/redis.ts?unmocked' as string;
const { RedisStorage } = (await import(REAL_REDIS_MODULE)) as typeof import('../storage/redis');

interface EvalCall {
    script: string;
    keys: string[];
    args: string[];
}

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

describe('RedisStorage.hIncrByIfExists (#7)', () => {
    let script: string;

    beforeEach(async () => {
        const { store, calls } = createStorage(() => 1);
        await store.hIncrByIfExists('file-id', 'dl', 1);
        script = calls[0].script;
    });

    it('guards the increment with EXISTS instead of a bare HINCRBY', () => {
        // A bare HINCRBY is precisely what recreates a deleted key.
        expect(script).toContain('EXISTS');
        expect(script).toContain('HINCRBY');
        // The EXISTS check must come first, or the guard is decorative.
        expect(script.indexOf('EXISTS')).toBeLessThan(script.indexOf('HINCRBY'));
    });

    it('passes the key and the field/increment as arguments', async () => {
        const { store, calls } = createStorage(() => 4);
        await store.hIncrByIfExists('file-id', 'dl', 1);
        expect(calls[0].keys).toEqual(['file-id']);
        expect(calls[0].args).toEqual(['dl', '1']);
    });

    it('returns the new counter value when the key exists', async () => {
        const { store } = createStorage(() => 4);
        await expect(store.hIncrByIfExists('file-id', 'dl', 1)).resolves.toBe(4);
    });

    it('returns null (not 0) when the key is gone, so callers can report 410', async () => {
        // The script answers -1 for "absent"; 0 is a legitimate counter value
        // and must never be confused with it.
        const { store } = createStorage(() => -1);
        await expect(store.hIncrByIfExists('file-id', 'dl', 1)).resolves.toBeNull();
    });

    it('treats a zero counter as a real value rather than as absent', async () => {
        const { store } = createStorage(() => 0);
        await expect(store.hIncrByIfExists('file-id', 'dl', 1)).resolves.toBe(0);
    });
});
