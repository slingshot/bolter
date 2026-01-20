import { Elysia, t } from 'elysia';
import { storage } from '../storage';
import { verifyAuth, verifyOwner } from '../middleware/auth';
import { downloadLogger as logger } from '../logger';

export const downloadRoutes = new Elysia()
  // Direct download for unencrypted single files (redirects to S3)
  .get('/download/direct/:id', async ({ params, set, redirect }) => {
    const { id } = params;

    const metadata = await storage.getMetadata(id);
    if (!metadata) {
      set.status = 404;
      return { error: 'File not found' };
    }

    // Only allow direct download for unencrypted files
    if (metadata.encrypted) {
      set.status = 400;
      return { error: 'Direct download not available for encrypted files' };
    }

    // Decode metadata to get filename
    let filename = 'download';
    if (metadata.metadata) {
      try {
        // Handle URL-safe base64 by converting to standard base64
        const standardB64 = metadata.metadata
          .replace(/-/g, '+')
          .replace(/_/g, '/');
        // Add padding if needed
        const padded = standardB64 + '==='.slice(0, (4 - (standardB64.length % 4)) % 4);
        const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));

        // Multi-file uploads that were zipped are fine for direct download
        // Only reject legacy multi-file uploads that weren't zipped
        if (decoded.files?.length > 1 && !decoded.zipped) {
          set.status = 400;
          return { error: 'Direct download not available for legacy multi-file uploads' };
        }

        // Use zip filename for zipped uploads, otherwise first file's name
        if (decoded.zipped && decoded.zipFilename) {
          filename = decoded.zipFilename;
        } else {
          filename = decoded.files?.[0]?.name || decoded.name || 'download';
        }
      } catch (e) {
        logger.warn({ id, error: e }, 'Failed to decode metadata for direct download');
      }
    }

    // Check if download limit already reached
    if (metadata.dl >= metadata.dlimit) {
      set.status = 410;
      return { error: 'Download limit reached' };
    }

    // Increment counter before redirect
    const newDl = await storage.incrementDownloadCount(id);

    // Check if limit exceeded after increment
    if (newDl > metadata.dlimit) {
      set.status = 410;
      return { error: 'Download limit reached' };
    }

    // Schedule deletion if limit reached
    if (newDl >= metadata.dlimit) {
      logger.info({ id, dl: newDl, dlimit: metadata.dlimit }, 'Download limit reached, scheduling deletion');
      setTimeout(() => storage.del(id), 300000); // 5 min delay
    }

    // Get signed URL with filename for Content-Disposition
    const signedUrl = await storage.getSignedDownloadUrl(id, filename);
    if (!signedUrl) {
      set.status = 500;
      return { error: 'Failed to generate download URL' };
    }

    // Redirect to S3
    return redirect(signedUrl, 302);
  })

  // Get download URL (with optional pre-signed URL for direct download)
  .get('/download/url/:id', async ({ params, headers, set }) => {
    const { id } = params;
    const authHeader = headers.authorization || null;

    const metadata = await storage.getMetadata(id);
    if (!metadata) {
      set.status = 404;
      return { error: 'File not found' };
    }

    // Verify authentication for encrypted files
    if (metadata.encrypted) {
      const { valid, nonce } = await verifyAuth(id, authHeader);
      set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

      if (!valid) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
    }

    // Get pre-signed download URL
    const signedUrl = await storage.getSignedDownloadUrl(id);
    if (!signedUrl) {
      return {
        useSignedUrl: false,
        dl: metadata.dl,
        dlimit: metadata.dlimit,
      };
    }

    return {
      useSignedUrl: true,
      url: signedUrl,
      dl: metadata.dl,
      dlimit: metadata.dlimit,
    };
  })

  // Stream download (fallback when pre-signed URLs not available)
  .get('/download/:id', async ({ params, headers, set }) => {
    const { id } = params;
    const authHeader = headers.authorization || null;

    const metadata = await storage.getMetadata(id);
    if (!metadata) {
      set.status = 404;
      return { error: 'File not found' };
    }

    // Verify authentication for encrypted files
    if (metadata.encrypted) {
      const { valid, nonce } = await verifyAuth(id, authHeader);
      set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

      if (!valid) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
    }

    const stream = await storage.getStream(id);
    if (!stream) {
      set.status = 404;
      return { error: 'File not found' };
    }

    set.headers['Content-Type'] = 'application/octet-stream';
    return stream;
  })

  // Blob download (alternative endpoint)
  .get('/download/blob/:id', async ({ params, headers, set }) => {
    const { id } = params;
    const authHeader = headers.authorization || null;

    const metadata = await storage.getMetadata(id);
    if (!metadata) {
      set.status = 404;
      return { error: 'File not found' };
    }

    if (metadata.encrypted) {
      const { valid, nonce } = await verifyAuth(id, authHeader);
      set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

      if (!valid) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
    }

    const stream = await storage.getStream(id);
    if (!stream) {
      set.status = 404;
      return { error: 'File not found' };
    }

    set.headers['Content-Type'] = 'application/octet-stream';
    return stream;
  })

  // Report download complete (increments counter, may delete file)
  .post('/download/complete/:id', async ({ params, headers, set }) => {
    const { id } = params;
    const authHeader = headers.authorization || null;

    const metadata = await storage.getMetadata(id);
    if (!metadata) {
      set.status = 404;
      return { error: 'File not found' };
    }

    // Verify authentication for encrypted files
    if (metadata.encrypted) {
      const { valid, nonce } = await verifyAuth(id, authHeader);
      set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

      if (!valid) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
    }

    // Increment download counter
    const newDl = await storage.incrementDownloadCount(id);

    // Check if download limit reached
    if (newDl >= metadata.dlimit) {
      console.log('Download limit reached, deleting file:', { id, dl: newDl, dlimit: metadata.dlimit });
      await storage.del(id);
      return { deleted: true, dl: newDl, dlimit: metadata.dlimit };
    }

    return { deleted: false, dl: newDl, dlimit: metadata.dlimit };
  })

  // Get file metadata
  .get('/metadata/:id', async ({ params, headers, set }) => {
    const { id } = params;
    const authHeader = headers.authorization || null;

    logger.info({ id }, 'Metadata request received');

    const metadata = await storage.getMetadata(id);
    if (!metadata) {
      logger.warn({ id }, 'File not found');
      set.status = 404;
      return { error: 'File not found' };
    }

    logger.debug({
      id,
      encrypted: metadata.encrypted,
      hasMetadata: !!metadata.metadata,
      metadataLength: metadata.metadata?.length,
      metadataPreview: metadata.metadata?.substring(0, 100),
    }, 'File metadata loaded');

    // Verify authentication for encrypted files
    if (metadata.encrypted) {
      const { valid, nonce } = await verifyAuth(id, authHeader);
      set.headers['WWW-Authenticate'] = `send-v1 ${nonce}`;

      if (!valid) {
        logger.warn({ id }, 'Authentication failed');
        set.status = 401;
        return { error: 'Authentication required' };
      }
      logger.debug({ id }, 'Authentication successful');
    }

    const ttl = await storage.getTTL(id);

    const response = {
      metadata: metadata.metadata || '',
      ttl,
      encrypted: metadata.encrypted,
    };

    logger.info({
      id,
      ttl,
      encrypted: metadata.encrypted,
      responseMetadataLength: response.metadata.length,
    }, 'Returning metadata response');

    return response;
  })

  // Check if file exists
  .get('/exists/:id', async ({ params }) => {
    const { id } = params;
    const exists = await storage.exists(id);
    return { exists };
  })

  // Delete file (owner only)
  .post('/delete/:id', async ({ params, body, set }) => {
    const { id } = params;
    const { owner_token } = body;

    if (!await verifyOwner(id, owner_token)) {
      set.status = 401;
      return { error: 'Invalid owner token' };
    }

    await storage.del(id);
    return { success: true };
  }, {
    body: t.Object({
      owner_token: t.String(),
    }),
  })

  // Update file parameters (owner only)
  .post('/params/:id', async ({ params, body, set }) => {
    const { id } = params;
    const { owner_token, dlimit } = body;

    if (!await verifyOwner(id, owner_token)) {
      set.status = 401;
      return { error: 'Invalid owner token' };
    }

    if (dlimit !== undefined) {
      await storage.setField(id, 'dlimit', dlimit.toString());
    }

    return { success: true };
  }, {
    body: t.Object({
      owner_token: t.String(),
      dlimit: t.Optional(t.Number()),
    }),
  })

  // Get file info (owner only)
  .post('/info/:id', async ({ params, body, set }) => {
    const { id } = params;
    const { owner_token } = body;

    if (!await verifyOwner(id, owner_token)) {
      set.status = 401;
      return { error: 'Invalid owner token' };
    }

    const metadata = await storage.getMetadata(id);
    if (!metadata) {
      set.status = 404;
      return { error: 'File not found' };
    }

    const ttl = await storage.getTTL(id);

    return {
      dl: metadata.dl,
      dlimit: metadata.dlimit,
      ttl,
    };
  }, {
    body: t.Object({
      owner_token: t.String(),
    }),
  })

  // Set password (owner only)
  .post('/password/:id', async ({ params, body, set }) => {
    const { id } = params;
    const { owner_token, auth } = body;

    if (!await verifyOwner(id, owner_token)) {
      set.status = 401;
      return { error: 'Invalid owner token' };
    }

    await storage.setField(id, 'auth', auth);

    return { success: true };
  }, {
    body: t.Object({
      owner_token: t.String(),
      auth: t.String(),
    }),
  });
