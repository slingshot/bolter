import { Elysia, t } from 'elysia';
import { storage } from '../storage';
import { verifyAuth, verifyOwner } from '../middleware/auth';

export const downloadRoutes = new Elysia({ prefix: '/api' })
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

    const ttl = await storage.getTTL(id);

    return {
      metadata: metadata.metadata || '',
      ttl,
      encrypted: metadata.encrypted,
    };
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
