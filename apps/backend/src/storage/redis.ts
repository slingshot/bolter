import { createClient, type RedisClientType } from 'redis';
import { config } from '../config';
import { captureError } from '../lib/sentry';

export class RedisStorage {
    private client: RedisClientType | null = null;
    private connecting = false;

    async connect(): Promise<void> {
        if (this.client || this.connecting) {
            return;
        }
        this.connecting = true;

        try {
            this.client = createClient({ url: config.redisUrl });

            this.client.on('error', (err) => {
                captureError(err, { operation: 'redis.connection', level: 'error' });
                console.error('Redis Client Error:', err);
            });

            await this.client.connect();
        } catch (err) {
            this.client = null;
            throw err;
        } finally {
            this.connecting = false;
        }
    }

    private async getClient(): Promise<RedisClientType> {
        if (!this.client) {
            await this.connect();
        }
        if (!this.client) {
            throw new Error('Redis client failed to initialize');
        }
        return this.client;
    }

    async ping(): Promise<boolean> {
        try {
            const client = await this.getClient();
            await client.ping();
            return true;
        } catch {
            return false;
        }
    }

    async hSet(key: string, field: string, value: string): Promise<void> {
        const client = await this.getClient();
        await client.hSet(key, field, value);
    }

    /**
     * EXISTS-guarded multi-field write, mirroring the guard on `rotateNonce`.
     *
     * A plain HSET recreates a key that expired (or was deleted) between the
     * caller's read and its write — and the recreated hash has NO TTL, so it
     * lives forever without the `owner`/`providerId` fields that make it
     * deletable and routable. Finalization writes must therefore be conditional
     * on the key still existing. Returns false when the key is gone, so callers
     * can report 404 instead of silently resurrecting metadata.
     */
    async hSetIfExists(key: string, data: Record<string, string>): Promise<boolean> {
        const entries = Object.entries(data);
        if (entries.length === 0) {
            return true;
        }
        const client = await this.getClient();
        const args: string[] = [];
        for (const [field, value] of entries) {
            args.push(field, value);
        }
        const result = await client.eval(
            "if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], unpack(ARGV)) return 1 else return 0 end",
            {
                keys: [key],
                arguments: args,
            },
        );
        return result === 1;
    }

    async hGet(key: string, field: string): Promise<string | null> {
        const client = await this.getClient();
        const result = await client.hGet(key, field);
        return result ?? null;
    }

    async hGetAll(key: string): Promise<Record<string, string> | null> {
        const client = await this.getClient();
        const result = await client.hGetAll(key);
        if (Object.keys(result).length === 0) {
            return null;
        }
        return result;
    }

    async hDel(key: string, ...fields: string[]): Promise<void> {
        const client = await this.getClient();
        await client.hDel(key, fields);
    }

    async expire(key: string, seconds: number): Promise<void> {
        const client = await this.getClient();
        await client.expire(key, seconds);
    }

    async del(key: string): Promise<void> {
        const client = await this.getClient();
        await client.del(key);
    }

    /**
     * Delete `key`, reporting whether THIS call is the one that removed it.
     *
     * `DEL` is atomic and returns the number of keys it removed, so exactly one
     * of N concurrent callers sees a non-zero reply. Gating follow-up
     * bookkeeping (the provider file-count decrement) on that reply is what
     * stops two racing deletes of the same file from each decrementing.
     * `redis.del` discards the reply, which is why this exists.
     */
    async delIfPresent(key: string): Promise<boolean> {
        const client = await this.getClient();
        return (await client.del(key)) > 0;
    }

    async exists(key: string): Promise<boolean> {
        const client = await this.getClient();
        const result = await client.exists(key);
        return result === 1;
    }

    async ttl(key: string): Promise<number> {
        const client = await this.getClient();
        return client.ttl(key);
    }

    async hIncrBy(key: string, field: string, increment: number): Promise<number> {
        const client = await this.getClient();
        return client.hIncrBy(key, field, increment);
    }

    /**
     * EXISTS-guarded HINCRBY (audit #7, trigger 3).
     *
     * A bare HINCRBY *creates* the hash when the key is absent. Download
     * counting reads metadata and then increments as two round trips, so a
     * delete or a TTL expiry landing in between would recreate the key as an
     * immortal `{dl:1}` hash — no TTL, no `owner` (undeletable), no
     * `providerId` (mis-routed). Guarding the increment keeps the deletion
     * final.
     *
     * @returns the new counter value, or `null` when the key no longer exists.
     */
    async hIncrByIfExists(key: string, field: string, increment: number): Promise<number | null> {
        const client = await this.getClient();
        const result = await client.eval(
            "if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end return redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])",
            {
                keys: [key],
                arguments: [field, String(increment)],
            },
        );
        return typeof result === 'number' && result >= 0 ? result : null;
    }

    async hSetMultiple(key: string, data: Record<string, string>): Promise<void> {
        const client = await this.getClient();
        await client.hSet(key, data);
    }

    async sAdd(key: string, ...members: string[]): Promise<void> {
        const client = await this.getClient();
        await client.sAdd(key, members);
    }

    async sMembers(key: string): Promise<string[]> {
        const client = await this.getClient();
        return client.sMembers(key);
    }

    async sRem(key: string, ...members: string[]): Promise<void> {
        const client = await this.getClient();
        await client.sRem(key, members);
    }

    async incrBy(key: string, increment: number): Promise<number> {
        const client = await this.getClient();
        return client.incrBy(key, increment);
    }

    async decrBy(key: string, decrement: number): Promise<number> {
        const client = await this.getClient();
        return client.decrBy(key, decrement);
    }

    async get(key: string): Promise<string | null> {
        const client = await this.getClient();
        return client.get(key);
    }

    async set(key: string, value: string): Promise<void> {
        const client = await this.getClient();
        await client.set(key, value);
    }

    // The EXISTS guard prevents resurrecting a just-expired key as a
    // TTL-less hash containing only the nonce field
    async rotateNonce(key: string, nonce: string): Promise<boolean> {
        const client = await this.getClient();
        const result = await client.eval(
            "if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'nonce', ARGV[1]) return 1 else return 0 end",
            {
                keys: [key],
                arguments: [nonce],
            },
        );
        return result === 1;
    }

    // Compare-and-swap rotation: the nonce is replaced only if it still holds
    // the value that was just validated. Read-validate-then-blind-write is not
    // atomic, so two concurrent requests carrying valid signatures for the same
    // nonce would both succeed and both rotate — consuming one nonce twice and
    // defeating replay protection. Returns false when the nonce already moved
    // on (or the key expired), so the caller can issue a fresh challenge.
    // EXISTS-guarded like rotateNonce so a just-expired key is never
    // resurrected as a TTL-less hash containing only the nonce field.
    async compareAndRotateNonce(
        key: string,
        expectedNonce: string,
        nextNonce: string,
    ): Promise<boolean> {
        const client = await this.getClient();
        const result = await client.eval(
            "if redis.call('EXISTS', KEYS[1]) == 1 and redis.call('HGET', KEYS[1], 'nonce') == ARGV[1] then redis.call('HSET', KEYS[1], 'nonce', ARGV[2]) return 1 else return 0 end",
            {
                keys: [key],
                arguments: [expectedNonce, nextNonce],
            },
        );
        return result === 1;
    }

    /**
     * Cap the metadata TTL to the limit-reached grace window, preserving the
     * original expiry in `expiresAt` so `/params` can restore it on a raise.
     *
     * Everything happens in one script on purpose. Done as a client-side
     * `TTL -> HSET expiresAt -> EXPIRE` chain (awaited or not), an owner's
     * `/params` raise can land between the `dl >= dlimit` decision and the
     * `expiresAt` write: `/params` writes the new `dlimit` first and only then
     * reads `expiresAt`, so it sees null, skips the TTL restore, and the chain
     * still caps the key to 300s. The grace timer then spares the object
     * (`dl < dlimit`) while Redis drops the metadata — an orphaned object behind
     * a 404 link. Re-reading `dl`/`dlimit` inside the same atomic step means a
     * raise either commits first (no cap at all) or commits after (`expiresAt`
     * is already there to restore from).
     *
     * Returns true when the cap was applied. No-ops (returning false) when the
     * key is gone, when the limit is no longer reached, or when the natural TTL
     * is already inside the grace window.
     */
    async capTTLAtDownloadLimit(key: string, graceSeconds: number): Promise<boolean> {
        const client = await this.getClient();
        const result = await client.eval(
            [
                "if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end",
                "local dl = tonumber(redis.call('HGET', KEYS[1], 'dl'))",
                "local dlimit = tonumber(redis.call('HGET', KEYS[1], 'dlimit'))",
                'if dl == nil or dlimit == nil or dl < dlimit then return 0 end',
                'local grace = tonumber(ARGV[1])',
                "local ttl = redis.call('TTL', KEYS[1])",
                'if ttl <= grace then return 0 end',
                "redis.call('HSET', KEYS[1], 'expiresAt', tostring(tonumber(ARGV[2]) + ttl))",
                "redis.call('EXPIRE', KEYS[1], grace)",
                'return 1',
            ].join('\n'),
            {
                keys: [key],
                arguments: [String(graceSeconds), String(Math.floor(Date.now() / 1000))],
            },
        );
        return result === 1;
    }
}

export const redis = new RedisStorage();
