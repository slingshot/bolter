/**
 * Engine persistence: a **separate IndexedDB database** (`bolter-upload-engine`)
 * from the legacy `bolter-uploads` store [R9]. Old deployed bundles must never
 * observe engine records — the legacy store's readers accept unknown versions
 * and would surface engine state in the legacy resume UI, and bumping the
 * shared DB's version would throw `VersionError` in still-open old tabs. The
 * engine never opens the legacy database.
 *
 * Worker-safe: no DOM globals — `indexedDB` exists in dedicated workers.
 * Connections are opened per operation and closed when the transaction
 * settles (the `upload-state.ts` house pattern), so a held `EngineStateStore`
 * never goes stale across `deleteDatabase` calls or version changes.
 */

/**
 * Identity facts for a persisted handle's file, captured at upload time [R13].
 * A one-click resume re-reads the file from its handle and must prove it is
 * still the file whose prefix was staged/uploaded — (name, size, mtime) plus
 * the sampled content fingerprint the legacy resume flow uses
 * (`computeContentFingerprint`). Checked by `verifyHandleFile` (resume.ts).
 */
export interface HandleSourceFacts {
    name: string;
    size: number;
    lastModified: number;
    fingerprint: string;
}

export interface EngineLease {
    fileId: string;
    uploadId: string;
    uploadToken?: string;
    ownerToken: string;
    createdAt: number;
    engineVersion: 1;
    /**
     * Persisted File System Access handles for the upload's source files
     * (Chromium progressive enhancement [R13]; structured-clonable, so
     * IndexedDB stores them). Only top-level dropped files and
     * `showOpenFilePicker` picks carry one. Written by the main thread at
     * delegation time; the engine's own lease writes preserve the field.
     */
    handles?: FileSystemFileHandle[];
    /** Parallel to `handles` — verification facts for one-click resume. */
    handleFacts?: HandleSourceFacts[];
}

export interface CompletionEnvelope {
    fileId: string;
    metadata: string; // exact encrypted-metadata payload for /upload/complete
    authKeyB64: string;
    manifest: { name: string; size: number; type: string }[];
    zipFilename?: string;
    expectedSize: number;
    encrypted: boolean;
    secretKeyB64?: string;
    timeLimit: number;
    downloadLimit: number;
}

export interface ProducerCheckpoint {
    fileId: string;
    nextPartNumber: number; // 1-based; next part to produce
    sourceOffset: number; // bytes consumed from source (plaintext domain)
    eceCounter: number; // next ECE record sequence number
    eofReached: boolean;
    finalRecordEmitted: boolean;
}

export interface EnginePartRecord {
    fileId: string;
    partNumber: number;
    size: number;
    staged: boolean;
    uploaded: boolean;
    etag?: string;
}

export interface EngineStateStore {
    putLease(l: EngineLease): Promise<void>;
    getLease(fileId: string): Promise<EngineLease | undefined>;
    putEnvelope(e: CompletionEnvelope): Promise<void>;
    getEnvelope(fileId: string): Promise<CompletionEnvelope | undefined>;
    putCheckpoint(c: ProducerCheckpoint): Promise<void>;
    getCheckpoint(fileId: string): Promise<ProducerCheckpoint | undefined>;
    putPart(p: EnginePartRecord): Promise<void>;
    getParts(fileId: string): Promise<EnginePartRecord[]>; // sorted by partNumber
    listLeases(): Promise<EngineLease[]>;
    clearUpload(fileId: string): Promise<void>; // lease+envelope+checkpoint+parts
}

const DB_NAME = 'bolter-upload-engine';
const DB_VERSION = 1;

const LEASES = 'leases';
const ENVELOPES = 'envelopes';
const CHECKPOINTS = 'checkpoints';
const PARTS = 'parts';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(LEASES)) {
                db.createObjectStore(LEASES, { keyPath: 'fileId' });
            }
            if (!db.objectStoreNames.contains(ENVELOPES)) {
                db.createObjectStore(ENVELOPES, { keyPath: 'fileId' });
            }
            if (!db.objectStoreNames.contains(CHECKPOINTS)) {
                db.createObjectStore(CHECKPOINTS, { keyPath: 'fileId' });
            }
            if (!db.objectStoreNames.contains(PARTS)) {
                db.createObjectStore(PARTS, { keyPath: ['fileId', 'partNumber'] });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Run `work` inside a single transaction. `work` issues its requests
 * synchronously and returns a thunk producing the result; the thunk is
 * evaluated only once the transaction has committed, when every request's
 * `result` is populated.
 */
async function run<T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => () => T,
): Promise<T> {
    const db = await openDB();
    return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let finish: () => T;
        try {
            finish = work(tx);
        } catch (err) {
            try {
                tx.abort();
            } catch {
                // already aborted — nothing partial can commit either way
            }
            db.close();
            reject(err);
            return;
        }
        tx.oncomplete = () => {
            db.close();
            resolve(finish());
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
        tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        };
    });
}

function putRecord(storeName: string, value: unknown): Promise<void> {
    return run(storeName, 'readwrite', (tx) => {
        tx.objectStore(storeName).put(value);
        return () => undefined;
    });
}

function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return run(storeName, 'readonly', (tx) => {
        const req = tx.objectStore(storeName).get(key);
        return () => req.result as T | undefined;
    });
}

/**
 * Every `[fileId, partNumber]` compound key for one fileId: in IndexedDB key
 * order the one-element array `[fileId]` sorts before `[fileId, <number>]`,
 * and arrays sort after numbers, so `[fileId, []]` sorts after them all.
 */
function partsRange(fileId: string): IDBKeyRange {
    return IDBKeyRange.bound([fileId], [fileId, []]);
}

export function openEngineState(): Promise<EngineStateStore> {
    // Open (and close) once eagerly so schema creation and availability
    // failures surface here, at a well-defined point, rather than inside an
    // arbitrary later operation.
    return openDB().then((db) => {
        db.close();
        return {
            putLease(l: EngineLease): Promise<void> {
                return putRecord(LEASES, l);
            },
            getLease(fileId: string): Promise<EngineLease | undefined> {
                return getRecord<EngineLease>(LEASES, fileId);
            },
            putEnvelope(e: CompletionEnvelope): Promise<void> {
                return putRecord(ENVELOPES, e);
            },
            getEnvelope(fileId: string): Promise<CompletionEnvelope | undefined> {
                return getRecord<CompletionEnvelope>(ENVELOPES, fileId);
            },
            putCheckpoint(c: ProducerCheckpoint): Promise<void> {
                return putRecord(CHECKPOINTS, c);
            },
            getCheckpoint(fileId: string): Promise<ProducerCheckpoint | undefined> {
                return getRecord<ProducerCheckpoint>(CHECKPOINTS, fileId);
            },
            putPart(p: EnginePartRecord): Promise<void> {
                return putRecord(PARTS, p);
            },
            getParts(fileId: string): Promise<EnginePartRecord[]> {
                return run(PARTS, 'readonly', (tx) => {
                    const req = tx.objectStore(PARTS).getAll(partsRange(fileId));
                    // getAll already returns compound-key order; sort anyway so
                    // the contract never rests on backend iteration details.
                    return () =>
                        (req.result as EnginePartRecord[]).sort(
                            (a, b) => a.partNumber - b.partNumber,
                        );
                });
            },
            listLeases(): Promise<EngineLease[]> {
                return run(LEASES, 'readonly', (tx) => {
                    const req = tx.objectStore(LEASES).getAll();
                    return () => req.result as EngineLease[];
                });
            },
            clearUpload(fileId: string): Promise<void> {
                // One transaction across all four stores: a crash mid-clear
                // must not leave a lease pointing at deleted parts.
                return run([LEASES, ENVELOPES, CHECKPOINTS, PARTS], 'readwrite', (tx) => {
                    tx.objectStore(LEASES).delete(fileId);
                    tx.objectStore(ENVELOPES).delete(fileId);
                    tx.objectStore(CHECKPOINTS).delete(fileId);
                    tx.objectStore(PARTS).delete(partsRange(fileId));
                    return () => undefined;
                });
            },
        };
    });
}
