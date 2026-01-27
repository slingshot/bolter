# Resumable Uploads Implementation Plan

## Overview

This document outlines a plan to implement resumable uploads for Bolter while maintaining the current architecture of direct client-to-Cloudflare R2 uploads (avoiding bandwidth costs by not proxying through the backend).

## Current Architecture

```
┌─────────────┐     presigned URLs      ┌─────────────┐
│   Browser   │ ◄───────────────────────│   Backend   │
│  (encrypt)  │                         │  (Elysia)   │
└──────┬──────┘                         └──────┬──────┘
       │                                       │
       │  direct upload (encrypted chunks)     │ metadata
       ▼                                       ▼
┌─────────────┐                         ┌─────────────┐
│ Cloudflare  │                         │    Redis    │
│     R2      │                         │             │
└─────────────┘                         └─────────────┘
```

**Key Properties to Preserve:**
- Client-side encryption (AES-GCM via ECE format)
- Direct browser → R2 uploads (no backend bandwidth costs)
- Presigned URLs for authentication
- Multipart uploads for large files (>100MB)

## Problem Statement

Currently, if a user closes their browser tab or experiences a crash during upload:
- All upload progress is lost
- Encryption keys are lost (in-memory only)
- Partial uploads remain on R2 as orphans (cleaned up after 7 days)
- User must start completely over

## Proposed Solution

Implement a Golden Retriever-inspired persistence layer that stores upload state locally, enabling recovery after browser crashes, accidental tab closures, or page refreshes.

---

## Architecture Design

### Storage Strategy (Inspired by Uppy Golden Retriever)

| Data Type | Storage | Reason |
|-----------|---------|--------|
| Upload session metadata | LocalStorage | Small, fast, survives crashes |
| Encryption keys | IndexedDB | More secure than localStorage for sensitive data |
| Completed part ETags | IndexedDB | Structured data, needs transactions |
| File blobs (small files <10MB) | IndexedDB | Can restore file content |
| File references (large files) | Service Worker Cache | Temporary, survives refresh but not crash |

### Data Structures

```typescript
// IndexedDB Schema: "bolter-uploads" database

// Object Store: "sessions"
interface UploadSession {
  id: string;                    // File ID from backend
  uploadId: string;              // S3 multipart upload ID
  createdAt: number;             // Timestamp
  expiresAt: number;             // Session expiry (match R2 7-day limit)

  // File info
  fileName: string;              // Original filename (or "files.zip")
  fileSize: number;              // Original file size
  encryptedSize: number;         // Calculated encrypted size
  isZip: boolean;                // Whether this is a multi-file zip
  fileList?: FileListItem[];     // Original files if zip

  // Encryption state
  secretKey: ArrayBuffer;        // Master encryption key (32 bytes)
  encrypted: boolean;            // Whether encryption is enabled

  // Upload configuration
  partSize: number;              // Bytes per part
  totalParts: number;            // Total number of parts

  // Progress tracking
  completedParts: CompletedPart[];
  bytesUploaded: number;         // Total bytes confirmed uploaded

  // Metadata for completion
  ownerToken: string;
  expireDays: number;
  downloadLimit: number;

  // Recovery state
  status: 'active' | 'paused' | 'recovering' | 'completed' | 'failed';
  lastError?: string;
  lastActivityAt: number;
}

interface CompletedPart {
  partNumber: number;
  etag: string;
  size: number;
}

interface FileListItem {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

// Object Store: "file-chunks" (for small files only)
interface StoredFileChunk {
  sessionId: string;
  chunkIndex: number;
  data: ArrayBuffer;
}
```

---

## Implementation Phases

### Phase 1: Core Persistence Layer

**Goal:** Create the storage infrastructure for saving/restoring upload state.

#### 1.1 Create IndexedDB Manager (`frontend/src/lib/uploadStorage.ts`)

```typescript
// Key functions to implement:
export const uploadStorage = {
  // Session management
  saveSession(session: UploadSession): Promise<void>;
  getSession(id: string): Promise<UploadSession | null>;
  getAllSessions(): Promise<UploadSession[]>;
  deleteSession(id: string): Promise<void>;

  // Part tracking
  markPartComplete(sessionId: string, part: CompletedPart): Promise<void>;
  getCompletedParts(sessionId: string): Promise<CompletedPart[]>;

  // File chunk storage (small files)
  storeFileChunk(sessionId: string, index: number, data: ArrayBuffer): Promise<void>;
  getFileChunks(sessionId: string): Promise<ArrayBuffer[]>;

  // Cleanup
  cleanExpiredSessions(): Promise<void>;
  clearAll(): Promise<void>;
}
```

#### 1.2 Add Session Recovery Detection

On app mount, check for recoverable sessions:

```typescript
// In frontend/src/App.tsx or a new hook
const recoverableSessions = await uploadStorage.getAllSessions();
const validSessions = recoverableSessions.filter(s =>
  s.status !== 'completed' &&
  s.expiresAt > Date.now()
);

if (validSessions.length > 0) {
  // Show recovery UI
}
```

### Phase 2: Upload Flow Integration

**Goal:** Integrate persistence into the existing upload flow.

#### 2.1 Modify Upload Initiation (`frontend/src/lib/api.ts`)

After receiving upload URL from backend, persist session:

```typescript
// In uploadFiles() after POST /upload/url succeeds
const session: UploadSession = {
  id: data.id,
  uploadId: data.uploadId,
  secretKey: keychain.secret, // Store the master key
  // ... other fields
};
await uploadStorage.saveSession(session);
```

#### 2.2 Track Part Completion

Modify `uploadPartWithRetry()` to persist on success:

```typescript
// After successful part upload
await uploadStorage.markPartComplete(sessionId, {
  partNumber,
  etag: response.headers.get('etag'),
  size: partData.byteLength
});
```

#### 2.3 Handle Presigned URL Refresh

**Critical:** Presigned URLs expire (typically 1 hour). Need new endpoint:

```typescript
// New backend endpoint: POST /upload/refresh-urls/:id
// Request: { ownerToken: string, parts: number[] }
// Response: { urls: { [partNumber]: string } }
```

### Phase 3: Resume Functionality

**Goal:** Implement the ability to resume interrupted uploads.

#### 3.1 New Backend Endpoint for Resume

```typescript
// POST /upload/resume/:id
// Verifies upload still exists, returns fresh presigned URLs for remaining parts

app.post('/upload/resume/:id', async ({ params, body }) => {
  const { ownerToken, completedParts } = body;

  // Verify ownership
  const metadata = await redis.hgetall(`file:${params.id}`);
  if (metadata.owner !== ownerToken) throw new Error('Unauthorized');

  // Check if multipart upload still exists on R2
  // Generate fresh presigned URLs for incomplete parts
  const remainingParts = [];
  for (let i = 1; i <= metadata.numParts; i++) {
    if (!completedParts.includes(i)) {
      remainingParts.push(i);
    }
  }

  const urls = await generatePresignedUrls(params.id, metadata.uploadId, remainingParts);

  return { urls, uploadId: metadata.uploadId };
});
```

#### 3.2 Frontend Resume Logic

```typescript
async function resumeUpload(session: UploadSession, file: File | null) {
  // 1. Request fresh presigned URLs for incomplete parts
  const completedPartNumbers = session.completedParts.map(p => p.partNumber);
  const { urls } = await api.post(`/upload/resume/${session.id}`, {
    ownerToken: session.ownerToken,
    completedParts: completedPartNumbers
  });

  // 2. Reconstruct keychain from stored secret
  const keychain = await deriveKeys(session.secretKey);

  // 3. Calculate byte offset for encryption stream
  const bytesAlreadyUploaded = session.completedParts.reduce((sum, p) => sum + p.size, 0);
  const recordsProcessed = Math.floor(bytesAlreadyUploaded / ENCRYPTED_RECORD_SIZE);

  // 4. Create encryption stream starting from correct position
  // This is the tricky part - need to handle partial records

  // 5. Resume uploading remaining parts
  await uploadRemainingParts(session, file, urls, keychain);
}
```

### Phase 4: Encryption Stream Recovery

**Goal:** Handle the complexity of resuming encrypted streams.

#### Challenge: ECE Record Counter

The encryption stream uses a counter-based nonce. To resume mid-stream, we need to:
1. Know exactly which record we're on
2. Have the correct nonce for that record

#### Solution: Part-Aligned Records

**Ensure part boundaries align with encryption record boundaries:**

```typescript
// Encryption record size: 64KB + 17 bytes overhead = 65,553 bytes
const ECE_RECORD_SIZE = 64 * 1024;
const ECE_OVERHEAD = 17; // 16-byte tag + 1-byte delimiter
const ENCRYPTED_RECORD_SIZE = ECE_RECORD_SIZE + ECE_OVERHEAD;

// Choose part size as multiple of encrypted record size
// Example: 200MB ≈ 3,052 records × 65,553 = 200,057,556 bytes
const PART_SIZE = Math.floor(200 * 1024 * 1024 / ENCRYPTED_RECORD_SIZE) * ENCRYPTED_RECORD_SIZE;
```

**Benefits:**
- Each part starts at a known record boundary
- Resume from any completed part without encryption state issues
- Record counter = `(partNumber - 1) * recordsPerPart`

### Phase 5: File Source Recovery

**Goal:** Handle the case where the original file is no longer available.

#### 5.1 Small Files (< 10MB): Store in IndexedDB

```typescript
if (file.size < 10 * 1024 * 1024) {
  const buffer = await file.arrayBuffer();
  await uploadStorage.storeFileChunk(sessionId, 0, buffer);
}
```

#### 5.2 Large Files: Service Worker Cache (Optional)

For large files, we can optionally use a Service Worker to hold file references:

```typescript
// Service Worker approach (survives refresh, not crash)
// frontend/src/sw.ts

self.addEventListener('message', async (event) => {
  if (event.data.type === 'STORE_FILE') {
    const cache = await caches.open('bolter-uploads');
    await cache.put(`/file/${event.data.sessionId}`, new Response(event.data.file));
  }
});
```

#### 5.3 File Re-selection Fallback

If file is not available, prompt user to re-select:

```typescript
// Show UI: "Please select the same file to continue upload"
// Verify file matches: name, size, lastModified
```

### Phase 6: Recovery UI

**Goal:** Create user interface for managing interrupted uploads.

#### 6.1 Recovery Banner Component

```tsx
// frontend/src/components/RecoveryBanner.tsx

function RecoveryBanner({ sessions }: { sessions: UploadSession[] }) {
  return (
    <div className="bg-yellow-100 border border-yellow-400 p-4 rounded">
      <h3>Interrupted Uploads Found</h3>
      {sessions.map(session => (
        <div key={session.id}>
          <span>{session.fileName}</span>
          <span>{formatProgress(session.bytesUploaded, session.encryptedSize)}</span>
          <button onClick={() => resumeUpload(session)}>Resume</button>
          <button onClick={() => discardUpload(session)}>Discard</button>
        </div>
      ))}
    </div>
  );
}
```

#### 6.2 Upload Progress Enhancement

Show which parts are complete with visual feedback:

```tsx
// Part progress visualization
<div className="part-grid">
  {Array.from({ length: totalParts }).map((_, i) => (
    <div
      key={i}
      className={cn(
        'part-block',
        completedParts.includes(i + 1) && 'completed',
        currentPart === i + 1 && 'uploading'
      )}
    />
  ))}
</div>
```

---

## API Changes Summary

### New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/upload/resume/:id` | Get fresh presigned URLs for incomplete parts |
| GET | `/upload/status/:id` | Check if multipart upload is still valid |

### Modified Endpoints

| Method | Path | Changes |
|--------|------|---------|
| POST | `/upload/url` | Return `recordsPerPart` for encryption alignment |
| POST | `/upload/complete` | Accept partial completion for recovery |

---

## Security Considerations

### Encryption Key Storage

- Keys stored in IndexedDB (more isolated than localStorage)
- Consider encrypting stored keys with a user-provided passphrase (optional feature)
- Auto-delete sessions after 7 days (match R2 lifecycle)
- Clear on successful completion

### Session Validation

- Always verify `ownerToken` on resume
- Validate file checksums when possible
- Timeout stale sessions aggressively

---

## Implementation Order

1. **Phase 1.1:** Create `uploadStorage.ts` with IndexedDB operations
2. **Phase 1.2:** Add session recovery detection on app mount
3. **Phase 4:** Implement part-aligned encryption (prerequisite for resumption)
4. **Phase 2.1-2.2:** Integrate persistence into upload flow
5. **Phase 3:** Implement resume endpoints and logic
6. **Phase 5:** Add file source recovery options
7. **Phase 6:** Build recovery UI components

---

## Estimated Complexity

| Phase | Effort | Risk |
|-------|--------|------|
| Phase 1 | Medium | Low - Standard IndexedDB patterns |
| Phase 2 | Medium | Low - Wrapper around existing logic |
| Phase 3 | High | Medium - URL refresh, state sync |
| Phase 4 | High | High - Encryption alignment critical |
| Phase 5 | Medium | Medium - File recovery UX |
| Phase 6 | Low | Low - Standard React components |

---

## Alternatives Considered

### 1. TUS Protocol

**Pros:** Industry standard, well-tested
**Cons:** Requires TUS server (bandwidth costs), doesn't work with presigned S3 URLs

### 2. Backend-Proxied Uploads

**Pros:** Simpler state management
**Cons:** Doubles bandwidth costs, defeats current architecture

### 3. Cloudflare Workers for State

**Pros:** Server-side state
**Cons:** Added complexity, still need client persistence for encryption keys

---

## References

- [Uppy Golden Retriever](https://uppy.io/docs/golden-retriever/) - File recovery plugin
- [S3 Multipart Upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) - AWS documentation
- [Cloudflare R2 Multipart](https://developers.cloudflare.com/r2/objects/multipart-objects/) - R2-specific behavior
- [TUS Protocol](https://tus.io/protocols/resumable-upload) - Resumable upload standard
- [tus-js-client](https://github.com/tus/tus-js-client) - JavaScript implementation reference
