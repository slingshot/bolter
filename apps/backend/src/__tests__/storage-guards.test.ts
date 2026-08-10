import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock the redis client BEFORE importing RedisStorage
// ---------------------------------------------------------------------------

interface EvalCall {
    script: string;
    options: { keys: string[]; arguments: string[] };
}

const evalCalls: EvalCall[] = [];
let evalResult: number = 1;

const fakeClient = {
    on: () => fakeClient,
    connect: () => Promise.resolve(),
    eval: (script: string, options: { keys: string[]; arguments: string[] }) => {
        evalCalls.push({ script, options });
        return Promise.resolve(evalResult);
    },
};

mock.module('redis', () => ({
    createClient: () => fakeClient,
}));

import { RedisStorage } from '../storage/redis';
// eslint-disable-next-line import/order -- import after the redis mock
import { objectExpiryTagging } from '../storage/s3';

// ---------------------------------------------------------------------------
// #7 — finalization writes must not resurrect a deleted/expired key
// ---------------------------------------------------------------------------

describe('RedisStorage.hSetIfExists', () => {
    let store: RedisStorage;

    beforeEach(async () => {
        evalCalls.length = 0;
        evalResult = 1;
        store = new RedisStorage();
        await store.connect();
    });

    it('should guard the write with EXISTS instead of a bare HSET', async () => {
        await store.hSetIfExists('file1', { auth: 'unencrypted' });

        expect(evalCalls.length).toBe(1);
        // A plain HSET recreates an expired key as an immortal, ownerless hash
        expect(evalCalls[0].script).toContain('EXISTS');
        expect(evalCalls[0].script).toContain('HSET');
        expect(evalCalls[0].options.keys).toEqual(['file1']);
    });

    it('should flatten every field/value pair into one atomic write', async () => {
        await store.hSetIfExists('file1', { auth: 'a', nonce: 'n', fileSize: '42' });

        expect(evalCalls.length).toBe(1);
        expect(evalCalls[0].options.arguments).toEqual([
            'auth',
            'a',
            'nonce',
            'n',
            'fileSize',
            '42',
        ]);
    });

    it('should report false when the key vanished', async () => {
        evalResult = 0;
        expect(await store.hSetIfExists('file1', { auth: 'a' })).toBe(false);
    });

    it('should report true when the write landed', async () => {
        evalResult = 1;
        expect(await store.hSetIfExists('file1', { auth: 'a' })).toBe(true);
    });

    it('should no-op (and not call Redis) for an empty field set', async () => {
        expect(await store.hSetIfExists('file1', {})).toBe(true);
        expect(evalCalls.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// #42 — per-file expiry can be surfaced to the bucket as an object tag
// ---------------------------------------------------------------------------

describe('objectExpiryTagging', () => {
    const expiry = new Date('2026-08-16T12:34:56.000Z');

    afterEach(() => {
        delete process.env.S3_OBJECT_EXPIRY_TAGGING;
        delete process.env.S3_OBJECT_EXPIRY_TAG_KEY;
    });

    it('should be off unless explicitly enabled', () => {
        // Object tagging is not universally supported by S3-compatible
        // backends; an unsupported x-amz-tagging would fail every upload
        expect(objectExpiryTagging(expiry)).toBeUndefined();
    });

    it('should emit a url-encoded key=value tag when enabled', () => {
        process.env.S3_OBJECT_EXPIRY_TAGGING = 'true';
        expect(objectExpiryTagging(expiry)).toBe('bolter-expires=2026-08-16');
    });

    it('should honor a configured tag key', () => {
        process.env.S3_OBJECT_EXPIRY_TAGGING = 'true';
        process.env.S3_OBJECT_EXPIRY_TAG_KEY = 'expires on';
        expect(objectExpiryTagging(expiry)).toBe('expires%20on=2026-08-16');
    });

    it('should return undefined for a missing or invalid expiry', () => {
        process.env.S3_OBJECT_EXPIRY_TAGGING = 'true';
        expect(objectExpiryTagging(undefined)).toBeUndefined();
        expect(objectExpiryTagging(new Date('nonsense'))).toBeUndefined();
    });
});
