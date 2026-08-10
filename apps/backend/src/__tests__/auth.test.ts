import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHmac } from 'node:crypto';

// --- Mock storage ---
const mockCompareAndRotateNonce = mock(() => Promise.resolve(true));
const mockStorage = {
    getMetadata: mock(() => Promise.resolve(null)),
    setField: mock(() => Promise.resolve()),
    getField: mock(() => Promise.resolve(null as string | null)),
    rotateNonce: mock(() => Promise.resolve(true)),
    redis: {
        compareAndRotateNonce: mockCompareAndRotateNonce,
    },
};

mock.module('../storage', () => ({
    storage: mockStorage,
}));

// --- Mock sentry ---
mock.module('../lib/sentry', () => ({
    captureError: mock(() => {
        /* noop */
    }),
    addBreadcrumb: mock(() => {
        /* noop */
    }),
}));

// Import AFTER mocking
import { verifyAuth, verifyOwner } from '../middleware/auth';

describe('verifyAuth', () => {
    beforeEach(() => {
        mockStorage.getMetadata.mockReset();
        mockStorage.setField.mockReset();
        mockStorage.getField.mockReset();
        mockStorage.getField.mockResolvedValue(null);
        mockStorage.rotateNonce.mockReset();
        mockStorage.rotateNonce.mockResolvedValue(true);
        mockCompareAndRotateNonce.mockReset();
        mockCompareAndRotateNonce.mockResolvedValue(true);
    });

    it('should return valid=false with empty nonce when file not found', async () => {
        mockStorage.getMetadata.mockResolvedValue(null);

        const result = await verifyAuth('nonexistent', null);

        expect(result.valid).toBe(false);
        expect(result.nonce).toBe('');
    });

    it('should return valid=true for unencrypted files without auth header', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: false,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', null);

        expect(result.valid).toBe(true);
        expect(result.nonce).toBe('');
    });

    it('should return valid=false with nonce for encrypted file without auth header', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', null);

        expect(result.valid).toBe(false);
        expect(result.nonce).toBeTruthy();
        // No stored nonce (legacy record) — a generated one should be persisted
        expect(mockStorage.rotateNonce).toHaveBeenCalledWith('test-id', result.nonce);
    });

    it('should return valid=false for malformed auth header', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', 'Bearer some-token');

        expect(result.valid).toBe(false);
        expect(result.nonce).toBeTruthy();
    });

    it('should return valid=false for malformed auth header with wrong prefix', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', 'send-v2 somesig');

        expect(result.valid).toBe(false);
    });

    it('should return valid=true when HMAC signature matches', async () => {
        // Generate a valid auth key and nonce pair
        const authKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));

        const authKeyB64 = authKey.toString('base64');
        const nonceB64 = nonce.toString('base64');

        // Compute the expected signature
        const expectedSig = createHmac('sha256', authKey).update(nonce).digest('base64');

        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: authKeyB64,
            nonce: nonceB64,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', `send-v1 ${expectedSig}`);

        expect(result.valid).toBe(true);
        expect(result.nonce).toBeTruthy();
        // The used nonce is consumed — a fresh one is persisted and returned,
        // via a compare-and-swap against the nonce that was just validated
        expect(result.nonce).not.toBe(nonceB64);
        expect(mockCompareAndRotateNonce).toHaveBeenCalledWith('test-id', nonceB64, result.nonce);
    });

    it('should return valid=false when HMAC signature is wrong', async () => {
        const authKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));

        const authKeyB64 = authKey.toString('base64');
        const nonceB64 = nonce.toString('base64');

        // Provide a completely wrong signature
        const wrongSig = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: authKeyB64,
            nonce: nonceB64,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', `send-v1 ${wrongSig}`);

        expect(result.valid).toBe(false);
    });

    it('should accept URL-safe base64 signatures (- and _ characters)', async () => {
        const authKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));

        const authKeyB64 = authKey.toString('base64');
        const nonceB64 = nonce.toString('base64');

        const expectedSig = createHmac('sha256', authKey).update(nonce).digest('base64');

        // Convert to URL-safe base64
        const urlSafeSig = expectedSig.replace(/\+/g, '-').replace(/\//g, '_');

        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: authKeyB64,
            nonce: nonceB64,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', `send-v1 ${urlSafeSig}`);

        expect(result.valid).toBe(true);
    });

    it('should return valid=false when metadata has no auth field', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: undefined,
            nonce: 'somenonce',
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', 'send-v1 somesig');

        expect(result.valid).toBe(false);
    });

    it('should return valid=false when metadata has no nonce field', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: 'someauth',
            nonce: undefined,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', 'send-v1 somesig');

        expect(result.valid).toBe(false);
    });

    it('should NOT rotate the stored nonce on unauthenticated calls', async () => {
        const storedNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
            'base64',
        );
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: 'c29tZS1hdXRoLWtleQ==',
            nonce: storedNonce,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result1 = await verifyAuth('test-id', null);
        const result2 = await verifyAuth('test-id', 'send-v1 d3Jvbmctc2ln');

        // Both calls echo the current stored nonce so concurrent viewers
        // holding the same challenge remain able to authenticate
        expect(result1.valid).toBe(false);
        expect(result2.valid).toBe(false);
        expect(result1.nonce).toBe(storedNonce);
        expect(result2.nonce).toBe(storedNonce);
        expect(mockStorage.rotateNonce).not.toHaveBeenCalled();
        expect(mockCompareAndRotateNonce).not.toHaveBeenCalled();
        expect(mockStorage.setField).not.toHaveBeenCalled();
    });

    it('should rotate the nonce only after a successful authentication', async () => {
        const authKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
        const nonceB64 = nonce.toString('base64');
        const expectedSig = createHmac('sha256', authKey).update(nonce).digest('base64');

        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: authKey.toString('base64'),
            nonce: nonceB64,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const failed = await verifyAuth('test-id', null);
        expect(failed.valid).toBe(false);
        expect(mockCompareAndRotateNonce).not.toHaveBeenCalled();

        const succeeded = await verifyAuth('test-id', `send-v1 ${expectedSig}`);
        expect(succeeded.valid).toBe(true);
        expect(succeeded.nonce).not.toBe(nonceB64);
        expect(mockStorage.rotateNonce).not.toHaveBeenCalled();
        expect(mockCompareAndRotateNonce).toHaveBeenCalledTimes(1);
        expect(mockCompareAndRotateNonce).toHaveBeenCalledWith(
            'test-id',
            nonceB64,
            succeeded.nonce,
        );
    });

    it('should generate and persist a nonce for legacy records missing one', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: 'c29tZS1hdXRoLWtleQ==',
            nonce: undefined,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', null);

        expect(result.valid).toBe(false);
        expect(result.nonce).toBeTruthy();
        expect(mockStorage.rotateNonce).toHaveBeenCalledTimes(1);
        expect(mockStorage.rotateNonce).toHaveBeenCalledWith('test-id', result.nonce);
    });

    it('should not generate a nonce for unencrypted files', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: false,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        await verifyAuth('test-id', null);

        expect(mockStorage.setField).not.toHaveBeenCalled();
        expect(mockStorage.rotateNonce).not.toHaveBeenCalled();
    });

    // --- #44: nonce rotation must be an atomic compare-and-swap ---

    it('should rotate the nonce with a CAS against the nonce that was validated', async () => {
        const authKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
        const nonceB64 = nonce.toString('base64');
        const expectedSig = createHmac('sha256', authKey).update(nonce).digest('base64');

        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: authKey.toString('base64'),
            nonce: nonceB64,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result = await verifyAuth('test-id', `send-v1 ${expectedSig}`);

        expect(result.valid).toBe(true);
        // Pre-fix this was a blind HSET that carried no expectation about the
        // nonce being replaced, so a concurrent verification of the same nonce
        // could not be detected.
        expect(mockCompareAndRotateNonce).toHaveBeenCalledTimes(1);
        const [key, expected, next] = mockCompareAndRotateNonce.mock.calls[0] as unknown as [
            string,
            string,
            string,
        ];
        expect(key).toBe('test-id');
        expect(expected).toBe(nonceB64);
        expect(next).toBe(result.nonce);
        expect(next).not.toBe(nonceB64);
    });

    it('should NOT accept a request that loses the nonce CAS (nonce consumed twice)', async () => {
        const authKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
        const nonceB64 = nonce.toString('base64');
        const expectedSig = createHmac('sha256', authKey).update(nonce).digest('base64');

        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: authKey.toString('base64'),
            nonce: nonceB64,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        // A concurrent request already consumed this nonce and rotated it
        mockCompareAndRotateNonce.mockResolvedValue(false);
        mockStorage.getField.mockResolvedValue('winner-rotated-nonce');

        const result = await verifyAuth('test-id', `send-v1 ${expectedSig}`);

        // Pre-fix both concurrent holders of the same nonce were accepted,
        // double-consuming it (and letting a replayed /download/complete
        // increment the counter twice).
        expect(result.valid).toBe(false);
        // ...and the loser is re-challenged with the nonce that actually won
        expect(result.nonce).toBe('winner-rotated-nonce');
        expect(mockStorage.getField).toHaveBeenCalledWith('test-id', 'nonce');
    });

    it('should fall back to the validated nonce when the CAS loser cannot re-read one', async () => {
        const authKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
        const nonceB64 = nonce.toString('base64');
        const expectedSig = createHmac('sha256', authKey).update(nonce).digest('base64');

        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: authKey.toString('base64'),
            nonce: nonceB64,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        // Key expired between the read and the CAS — nothing to re-challenge with
        mockCompareAndRotateNonce.mockResolvedValue(false);
        mockStorage.getField.mockResolvedValue(null);

        const result = await verifyAuth('test-id', `send-v1 ${expectedSig}`);

        expect(result.valid).toBe(false);
        expect(result.nonce).toBe(nonceB64);
    });

    it('should let only one of two concurrent verifications of the same nonce succeed', async () => {
        const authKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
        const nonceB64 = nonce.toString('base64');
        const expectedSig = createHmac('sha256', authKey).update(nonce).digest('base64');

        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: authKey.toString('base64'),
            nonce: nonceB64,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        // Simulate the real Lua CAS: the stored nonce only matches once
        let stored = nonceB64;
        mockCompareAndRotateNonce.mockImplementation(
            (...args: unknown[]) =>
                new Promise<boolean>((resolve) => {
                    const [, expected, next] = args as [string, string, string];
                    if (stored !== expected) {
                        resolve(false);
                        return;
                    }
                    stored = next;
                    resolve(true);
                }),
        );
        mockStorage.getField.mockImplementation(() => Promise.resolve(stored));

        const [a, b] = await Promise.all([
            verifyAuth('test-id', `send-v1 ${expectedSig}`),
            verifyAuth('test-id', `send-v1 ${expectedSig}`),
        ]);

        // Exactly one wins; the other is rejected and re-challenged. Pre-fix
        // both returned valid=true, consuming one nonce twice.
        expect([a.valid, b.valid].filter(Boolean).length).toBe(1);
        const loser = a.valid ? b : a;
        expect(loser.nonce).toBe(stored);
    });

    it('should handle exceptions in HMAC computation gracefully', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            auth: 'not-valid-base64!!!',
            nonce: 'also-not-valid!!!',
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        // Should not throw, should return valid=false
        const result = await verifyAuth('test-id', 'send-v1 somesig');

        expect(result.valid).toBe(false);
        expect(result.nonce).toBeTruthy();
    });
});

describe('verifyOwner', () => {
    beforeEach(() => {
        mockStorage.getField.mockReset();
    });

    it('should return true for correct owner token', async () => {
        const token = 'abc123def456';
        mockStorage.getField.mockResolvedValue(token);

        const result = await verifyOwner('test-id', token);

        expect(result).toBe(true);
        expect(mockStorage.getField).toHaveBeenCalledWith('test-id', 'owner');
    });

    it('should return false for wrong owner token', async () => {
        mockStorage.getField.mockResolvedValue('correct-token');

        const result = await verifyOwner('test-id', 'wrong-token-xx');

        expect(result).toBe(false);
    });

    it('should return false for empty owner token', async () => {
        mockStorage.getField.mockResolvedValue('stored-token');

        const result = await verifyOwner('test-id', '');

        expect(result).toBe(false);
    });

    it('should return false when stored owner is null (file not found)', async () => {
        mockStorage.getField.mockResolvedValue(null);

        const result = await verifyOwner('test-id', 'some-token');

        expect(result).toBe(false);
    });

    it('should return false for different length tokens (timing-safe)', async () => {
        mockStorage.getField.mockResolvedValue('short');

        const result = await verifyOwner('test-id', 'much-longer-token');

        expect(result).toBe(false);
    });

    it('should use timing-safe comparison (returns false for similar but different tokens)', async () => {
        const token = 'abcdef123456';
        mockStorage.getField.mockResolvedValue(token);

        // Off by one character
        const result = await verifyOwner('test-id', 'abcdef123457');

        expect(result).toBe(false);
    });
});
