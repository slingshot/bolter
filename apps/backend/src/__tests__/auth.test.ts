import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHmac } from 'node:crypto';

// --- Mock storage ---
const mockStorage = {
    getMetadata: mock(() => Promise.resolve(null)),
    setField: mock(() => Promise.resolve()),
    getField: mock(() => Promise.resolve(null)),
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
        // A new nonce should have been stored
        expect(mockStorage.setField).toHaveBeenCalledWith('test-id', 'nonce', expect.any(String));
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

    it('should generate a new nonce on every call for encrypted files', async () => {
        mockStorage.getMetadata.mockResolvedValue({
            id: 'test-id',
            encrypted: true,
            prefix: '1',
            owner: 'owner123',
            dl: 0,
            dlimit: 1,
            fileSize: 1000,
        });

        const result1 = await verifyAuth('test-id', null);
        const result2 = await verifyAuth('test-id', null);

        // Both should have nonces
        expect(result1.nonce).toBeTruthy();
        expect(result2.nonce).toBeTruthy();

        // setField should have been called twice (once per call)
        expect(mockStorage.setField).toHaveBeenCalledTimes(2);

        // The nonces passed to setField should be different (random)
        const firstNonce = mockStorage.setField.mock.calls[0][2];
        const secondNonce = mockStorage.setField.mock.calls[1][2];
        expect(firstNonce).not.toBe(secondNonce);
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
