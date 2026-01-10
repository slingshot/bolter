import { createHmac, timingSafeEqual } from 'crypto';
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
  authHeader: string | null
): Promise<{ valid: boolean; nonce: string }> {
  const metadata = await storage.getMetadata(id);

  if (!metadata) {
    return { valid: false, nonce: '' };
  }

  // For unencrypted files, no auth needed
  if (!metadata.encrypted) {
    return { valid: true, nonce: '' };
  }

  // Generate new nonce for next request
  const newNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  await storage.setField(id, 'nonce', newNonce);

  if (!authHeader) {
    return { valid: false, nonce: newNonce };
  }

  // Parse authorization header
  const match = authHeader.match(/^send-v1\s+(.+)$/);
  if (!match) {
    return { valid: false, nonce: newNonce };
  }

  const providedSig = match[1];
  const storedAuth = metadata.auth;
  const storedNonce = metadata.nonce;

  if (!storedAuth || !storedNonce) {
    return { valid: false, nonce: newNonce };
  }

  try {
    // Compute expected HMAC: HMAC-SHA256(authKey, nonce)
    const authKeyBuffer = Buffer.from(storedAuth, 'base64');
    const nonceBuffer = Buffer.from(storedNonce, 'base64');
    const expectedSig = createHmac('sha256', authKeyBuffer)
      .update(nonceBuffer)
      .digest('base64');

    // Timing-safe comparison
    const providedBuffer = Buffer.from(providedSig, 'base64');
    const expectedBuffer = Buffer.from(expectedSig, 'base64');

    if (providedBuffer.length !== expectedBuffer.length) {
      return { valid: false, nonce: newNonce };
    }

    const valid = timingSafeEqual(providedBuffer, expectedBuffer);
    return { valid, nonce: newNonce };
  } catch (e) {
    console.error('Auth verification error:', e);
    return { valid: false, nonce: newNonce };
  }
}

/**
 * Verify owner token for file management operations
 */
export async function verifyOwner(id: string, ownerToken: string): Promise<boolean> {
  const storedOwner = await storage.getField(id, 'owner');
  if (!storedOwner || !ownerToken) return false;

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
