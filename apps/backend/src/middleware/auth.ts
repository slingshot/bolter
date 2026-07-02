import { createHmac, timingSafeEqual } from 'node:crypto';
import { captureError } from '../lib/sentry';
import { storage } from '../storage';

export interface AuthContext {
    authenticated: boolean;
    id?: string;
    nonce?: string;
}

/**
 * Verify HMAC authentication for encrypted file access
 * Format: Authorization: send-v1 <hmac-signature>
 */
export async function verifyAuth(
    id: string,
    authHeader: string | null,
): Promise<{ valid: boolean; nonce: string }> {
    const metadata = await storage.getMetadata(id);

    if (!metadata) {
        return { valid: false, nonce: '' };
    }

    // For unencrypted files, no auth needed
    if (!metadata.encrypted) {
        return { valid: true, nonce: '' };
    }

    // Legacy records may lack a nonce — issue and persist one as the challenge
    let storedNonce = metadata.nonce;
    if (!storedNonce) {
        storedNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
        await storage.rotateNonce(id, storedNonce);
    }

    // Invalid attempts echo the current nonce without rotating, so concurrent
    // viewers holding the same challenge are not invalidated by each other
    if (!authHeader) {
        return { valid: false, nonce: storedNonce };
    }

    // Parse authorization header
    const match = authHeader.match(/^send-v1\s+(.+)$/);
    if (!match) {
        return { valid: false, nonce: storedNonce };
    }

    const providedSig = match[1];
    const storedAuth = metadata.auth;

    if (!storedAuth) {
        return { valid: false, nonce: storedNonce };
    }

    try {
        // Compute expected HMAC: HMAC-SHA256(authKey, nonce)
        const authKeyBuffer = Buffer.from(storedAuth, 'base64');
        const nonceBuffer = Buffer.from(storedNonce, 'base64');
        const expectedSig = createHmac('sha256', authKeyBuffer)
            .update(nonceBuffer)
            .digest('base64');

        // Convert URL-safe base64 to standard base64
        const standardSig = providedSig.replace(/-/g, '+').replace(/_/g, '/');

        // Timing-safe comparison
        const providedBuffer = Buffer.from(standardSig, 'base64');
        const expectedBuffer = Buffer.from(expectedSig, 'base64');

        if (providedBuffer.length !== expectedBuffer.length) {
            return { valid: false, nonce: storedNonce };
        }

        const valid = timingSafeEqual(providedBuffer, expectedBuffer);
        if (!valid) {
            return { valid: false, nonce: storedNonce };
        }

        // Rotate only after a successful verification — the used nonce is
        // consumed immediately, preserving replay protection
        const newNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
        await storage.rotateNonce(id, newNonce);
        return { valid: true, nonce: newNonce };
    } catch (e) {
        captureError(e, {
            operation: 'auth.verify',
            extra: { id, hasAuthHeader: !!authHeader },
            level: 'warning',
        });
        console.error('Auth verification error:', e);
        return { valid: false, nonce: storedNonce };
    }
}

/**
 * Verify owner token for file management operations
 */
export async function verifyOwner(id: string, ownerToken: string): Promise<boolean> {
    const storedOwner = await storage.getField(id, 'owner');
    if (!storedOwner || !ownerToken) {
        return false;
    }

    try {
        const storedBuffer = Buffer.from(storedOwner);
        const providedBuffer = Buffer.from(ownerToken);

        if (storedBuffer.length !== providedBuffer.length) {
            return false;
        }

        return timingSafeEqual(storedBuffer, providedBuffer);
    } catch {
        return false;
    }
}
