/**
 * Durable local state.
 *
 * Two jobs that look similar and are not: remembering what you sent (history,
 * so `ls` can reprint a working link and `rm` can delete it), and remembering
 * enough about an *interrupted* send to finish it (resume).
 *
 * SQLite rather than a JSON file because the resume half needs transactions.
 * The ordering rule is the same one the browser engine paid to learn: a part's
 * completion and the progress it implies must commit together, or a crash
 * between them leaves a record that claims more than it can prove.
 */

import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { stateDir, stateFile } from '../core/paths';

export interface UploadRecord {
    id: string;
    instance: string;
    /** Share URL without its fragment. */
    url: string;
    /** Decryption key, when the send was encrypted and secrets are stored. */
    secret: string | null;
    ownerToken: string;
    name: string;
    size: number;
    encrypted: 0 | 1;
    archive: 0 | 1;
    createdAt: number;
    /** Epoch ms the instance said it expires, when it told us. */
    expiresAt: number | null;
    downloadLimit: number;
    /** 'complete' once the upload finished; otherwise resumable. */
    status: 'pending' | 'complete';
    uploadId: string | null;
    uploadToken: string | null;
    partSize: number | null;
    totalParts: number | null;
    /** Absolute paths of the sources, JSON-encoded, for a resume. */
    sourcePaths: string | null;
}

export interface PartRecord {
    fileId: string;
    partNumber: number;
    etag: string;
    size: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,
    ownerToken TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    encrypted INTEGER NOT NULL,
    archive INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER,
    downloadLimit INTEGER NOT NULL,
    status TEXT NOT NULL,
    uploadId TEXT,
    uploadToken TEXT,
    partSize INTEGER,
    totalParts INTEGER,
    sourcePaths TEXT
);
CREATE INDEX IF NOT EXISTS uploads_created ON uploads(createdAt DESC);

CREATE TABLE IF NOT EXISTS parts (
    fileId TEXT NOT NULL,
    partNumber INTEGER NOT NULL,
    etag TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (fileId, partNumber)
);

CREATE TABLE IF NOT EXISTS instances (
    origin TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    fetchedAt INTEGER NOT NULL
);
`;

export interface StateStore {
    recordPending(record: Omit<UploadRecord, 'status'>): void;
    markComplete(id: string, patch: Partial<UploadRecord>): void;
    recordPart(part: PartRecord): void;
    partsFor(id: string): PartRecord[];
    list(options?: { includePending?: boolean; limit?: number }): UploadRecord[];
    get(id: string): UploadRecord | null;
    forget(id: string): void;
    pending(): UploadRecord[];
    /** Drop history for links that have certainly expired. */
    prune(now?: number): number;
    close(): void;
}

let cached: { store: StateStore; path: string } | undefined;

export function openState(env: NodeJS.ProcessEnv = process.env): StateStore {
    const path = stateFile(env);
    if (cached?.path === path) {
        return cached.store;
    }
    mkdirSync(stateDir(env), { recursive: true });
    const db = new Database(path, { create: true });
    // WAL keeps a reader (a second `sendfm ls`) from blocking a running
    // upload's writes, which is the realistic concurrent case.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);

    // The database holds decryption keys and owner tokens — bearer credentials
    // for deleting someone's file. Nobody else on the machine needs to read it.
    try {
        chmodSync(path, 0o600);
    } catch {
        // Windows and some filesystems have no POSIX mode; the directory
        // permissions are the fallback there.
    }

    const store: StateStore = {
        recordPending(record) {
            db.query(
                `INSERT OR REPLACE INTO uploads
                 (id, instance, url, secret, ownerToken, name, size, encrypted, archive,
                  createdAt, expiresAt, downloadLimit, status, uploadId, uploadToken,
                  partSize, totalParts, sourcePaths)
                 VALUES ($id, $instance, $url, $secret, $ownerToken, $name, $size, $encrypted,
                         $archive, $createdAt, $expiresAt, $downloadLimit, 'pending', $uploadId,
                         $uploadToken, $partSize, $totalParts, $sourcePaths)`,
            ).run({
                $id: record.id,
                $instance: record.instance,
                $url: record.url,
                $secret: record.secret,
                $ownerToken: record.ownerToken,
                $name: record.name,
                $size: record.size,
                $encrypted: record.encrypted,
                $archive: record.archive,
                $createdAt: record.createdAt,
                $expiresAt: record.expiresAt,
                $downloadLimit: record.downloadLimit,
                $uploadId: record.uploadId,
                $uploadToken: record.uploadToken,
                $partSize: record.partSize,
                $totalParts: record.totalParts,
                $sourcePaths: record.sourcePaths,
            });
        },

        markComplete(id, patch) {
            db.query(
                `UPDATE uploads SET status = 'complete',
                    url = COALESCE($url, url),
                    size = COALESCE($size, size),
                    expiresAt = COALESCE($expiresAt, expiresAt)
                 WHERE id = $id`,
            ).run({
                $id: id,
                $url: patch.url ?? null,
                $size: patch.size ?? null,
                $expiresAt: patch.expiresAt ?? null,
            });
            // A completed upload's part list is dead weight; the object exists.
            db.query('DELETE FROM parts WHERE fileId = $id').run({ $id: id });
        },

        recordPart(part) {
            db.query(
                `INSERT OR REPLACE INTO parts (fileId, partNumber, etag, size)
                 VALUES ($fileId, $partNumber, $etag, $size)`,
            ).run({
                $fileId: part.fileId,
                $partNumber: part.partNumber,
                $etag: part.etag,
                $size: part.size,
            });
        },

        partsFor(id) {
            return db
                .query('SELECT * FROM parts WHERE fileId = $id ORDER BY partNumber')
                .all({ $id: id }) as PartRecord[];
        },

        list(options = {}) {
            const where = options.includePending ? '' : "WHERE status = 'complete'";
            const limit = options.limit ?? 100;
            return db
                .query(`SELECT * FROM uploads ${where} ORDER BY createdAt DESC LIMIT ${limit}`)
                .all() as UploadRecord[];
        },

        get(id) {
            return (db.query('SELECT * FROM uploads WHERE id = $id').get({ $id: id }) ??
                null) as UploadRecord | null;
        },

        forget(id) {
            db.query('DELETE FROM parts WHERE fileId = $id').run({ $id: id });
            db.query('DELETE FROM uploads WHERE id = $id').run({ $id: id });
        },

        pending() {
            return db
                .query("SELECT * FROM uploads WHERE status = 'pending' ORDER BY createdAt DESC")
                .all() as UploadRecord[];
        },

        prune(now = Date.now()) {
            // Only records the instance gave an expiry for. Without one there
            // is no basis for deciding, and quietly deleting someone's record
            // of a file that still exists is worse than keeping a stale row.
            const result = db
                .query('DELETE FROM uploads WHERE expiresAt IS NOT NULL AND expiresAt < $now')
                .run({ $now: now });
            return result.changes;
        },

        close() {
            db.close();
            cached = undefined;
        },
    };

    cached = { store, path };
    return store;
}
