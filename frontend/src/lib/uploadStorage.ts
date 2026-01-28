/**
 * IndexedDB storage layer for resumable uploads
 * Persists upload sessions, encryption keys, and completed parts
 */

const DB_NAME = 'bolter-uploads';
const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';
const CHUNKS_STORE = 'chunks';

// Session expiry matches R2's 7-day multipart upload lifecycle
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// Maximum file size to store in IndexedDB for recovery
const MAX_STORED_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export interface FileListItem {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export type UploadSessionStatus =
  | 'active'
  | 'paused'
  | 'recovering'
  | 'completed'
  | 'failed';

export interface UploadSession {
  id: string;                    // File ID from backend
  uploadId: string;              // S3 multipart upload ID
  createdAt: number;             // Timestamp
  expiresAt: number;             // Session expiry (R2 7-day limit)

  // File info
  fileName: string;              // Original filename (or "files.zip")
  fileSize: number;              // Original file size (plaintext)
  encryptedSize: number;         // Calculated encrypted size
  isZip: boolean;                // Whether this is a multi-file zip
  fileList: FileListItem[];      // Original files info

  // Encryption state
  secretKey: string;             // Master encryption key (base64)
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
  status: UploadSessionStatus;
  lastError?: string;
  lastActivityAt: number;
}

export interface StoredFileChunk {
  sessionId: string;
  chunkIndex: number;
  data: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open or create the IndexedDB database
 */
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[uploadStorage] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Sessions store
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const sessionsStore = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
        sessionsStore.createIndex('status', 'status', { unique: false });
        sessionsStore.createIndex('expiresAt', 'expiresAt', { unique: false });
      }

      // Chunks store (for small files)
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunksStore = db.createObjectStore(CHUNKS_STORE, {
          keyPath: ['sessionId', 'chunkIndex']
        });
        chunksStore.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
  });

  return dbPromise;
}

/**
 * Save an upload session
 */
export async function saveSession(session: UploadSession): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = transaction.objectStore(SESSIONS_STORE);
    const request = store.put(session);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Get an upload session by ID
 */
export async function getSession(id: string): Promise<UploadSession | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSIONS_STORE, 'readonly');
    const store = transaction.objectStore(SESSIONS_STORE);
    const request = store.get(id);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

/**
 * Get all upload sessions
 */
export async function getAllSessions(): Promise<UploadSession[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSIONS_STORE, 'readonly');
    const store = transaction.objectStore(SESSIONS_STORE);
    const request = store.getAll();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || []);
  });
}

/**
 * Get recoverable sessions (active/paused, not expired)
 */
export async function getRecoverableSessions(): Promise<UploadSession[]> {
  const sessions = await getAllSessions();
  const now = Date.now();

  return sessions.filter(session =>
    session.status !== 'completed' &&
    session.status !== 'failed' &&
    session.expiresAt > now &&
    session.completedParts.length < session.totalParts
  );
}

/**
 * Delete an upload session
 */
export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();

  // Delete session and associated chunks
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SESSIONS_STORE, CHUNKS_STORE], 'readwrite');

    // Delete session
    const sessionsStore = transaction.objectStore(SESSIONS_STORE);
    sessionsStore.delete(id);

    // Delete associated chunks
    const chunksStore = transaction.objectStore(CHUNKS_STORE);
    const chunksIndex = chunksStore.index('sessionId');
    const chunksRequest = chunksIndex.getAllKeys(IDBKeyRange.only(id));

    chunksRequest.onsuccess = () => {
      const keys = chunksRequest.result;
      for (const key of keys) {
        chunksStore.delete(key);
      }
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Mark a part as completed
 */
export async function markPartComplete(
  sessionId: string,
  part: CompletedPart
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Check if part already exists
  const existingIndex = session.completedParts.findIndex(
    p => p.partNumber === part.partNumber
  );

  if (existingIndex >= 0) {
    session.completedParts[existingIndex] = part;
  } else {
    session.completedParts.push(part);
  }

  session.bytesUploaded = session.completedParts.reduce((sum, p) => sum + p.size, 0);
  session.lastActivityAt = Date.now();

  await saveSession(session);
}

/**
 * Update session status
 */
export async function updateSessionStatus(
  sessionId: string,
  status: UploadSessionStatus,
  error?: string
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  session.status = status;
  session.lastActivityAt = Date.now();
  if (error !== undefined) {
    session.lastError = error;
  }

  await saveSession(session);
}

/**
 * Store a file chunk (for small files that can be recovered)
 */
export async function storeFileChunk(
  sessionId: string,
  chunkIndex: number,
  data: ArrayBuffer
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHUNKS_STORE, 'readwrite');
    const store = transaction.objectStore(CHUNKS_STORE);
    const chunk: StoredFileChunk = { sessionId, chunkIndex, data };
    const request = store.put(chunk);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Get all chunks for a session
 */
export async function getFileChunks(sessionId: string): Promise<ArrayBuffer[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHUNKS_STORE, 'readonly');
    const store = transaction.objectStore(CHUNKS_STORE);
    const index = store.index('sessionId');
    const request = index.getAll(IDBKeyRange.only(sessionId));

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const chunks = request.result as StoredFileChunk[];
      // Sort by chunk index and extract data
      chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      resolve(chunks.map(c => c.data));
    };
  });
}

/**
 * Clean up expired sessions
 */
export async function cleanExpiredSessions(): Promise<number> {
  const sessions = await getAllSessions();
  const now = Date.now();
  let cleaned = 0;

  for (const session of sessions) {
    if (session.expiresAt < now || session.status === 'completed') {
      await deleteSession(session.id);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Clear all upload data
 */
export async function clearAll(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SESSIONS_STORE, CHUNKS_STORE], 'readwrite');

    transaction.objectStore(SESSIONS_STORE).clear();
    transaction.objectStore(CHUNKS_STORE).clear();

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Create a new upload session
 */
export function createSession(params: {
  id: string;
  uploadId: string;
  fileName: string;
  fileSize: number;
  encryptedSize: number;
  isZip: boolean;
  fileList: FileListItem[];
  secretKey: string;
  encrypted: boolean;
  partSize: number;
  totalParts: number;
  ownerToken: string;
  expireDays: number;
  downloadLimit: number;
}): UploadSession {
  const now = Date.now();
  return {
    ...params,
    createdAt: now,
    expiresAt: now + SESSION_EXPIRY_MS,
    completedParts: [],
    bytesUploaded: 0,
    status: 'active',
    lastActivityAt: now,
  };
}

/**
 * Check if a file is small enough to store in IndexedDB
 */
export function canStoreFile(fileSize: number): boolean {
  return fileSize <= MAX_STORED_FILE_SIZE;
}

/**
 * Store a small file for recovery
 */
export async function storeSmallFile(sessionId: string, file: File): Promise<void> {
  if (!canStoreFile(file.size)) {
    console.warn('[uploadStorage] File too large to store:', file.size);
    return;
  }

  const buffer = await file.arrayBuffer();
  await storeFileChunk(sessionId, 0, buffer);
}

/**
 * Recover a stored file
 */
export async function recoverStoredFile(
  sessionId: string,
  fileName: string,
  fileType: string
): Promise<File | null> {
  const chunks = await getFileChunks(sessionId);
  if (chunks.length === 0) {
    return null;
  }

  // Combine all chunks
  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  return new File([combined], fileName, { type: fileType });
}

// Export storage interface
export const uploadStorage = {
  saveSession,
  getSession,
  getAllSessions,
  getRecoverableSessions,
  deleteSession,
  markPartComplete,
  updateSessionStatus,
  storeFileChunk,
  getFileChunks,
  cleanExpiredSessions,
  clearAll,
  createSession,
  canStoreFile,
  storeSmallFile,
  recoverStoredFile,
};
