/**
 * Typed client↔worker protocol for the upload engine. The job/source shapes
 * cross the worker boundary via structured clone (`File`/`Blob` clone as
 * cheap handles — no byte copy), and every message is a discriminated union
 * so both sides exhaustively switch on `type`.
 *
 * Worker-safe: types only, no DOM globals.
 */

import type { CompletionEnvelope } from './state';

export interface EngineJob {
    fileId: string;
    uploadId: string;
    uploadToken?: string;
    ownerToken: string;
    partUrls: string[]; // index 0 = part 1
    partSize: number; // nominal per-part payload size (ciphertext size when encrypted)
    encrypted: boolean;
    secretKeyB64?: string;
    maxConcurrent: number;
    declaredTotalSize: number; // payload bytes declared at allocation (ciphertext when encrypted)
    source: EngineSource;
}

export type EngineSource =
    | { kind: 'file'; file: File }
    | { kind: 'blob'; blob: Blob }
    | { kind: 'zip'; files: File[]; names: string[] };

export type ClientToWorker =
    | { type: 'start'; job: EngineJob; envelope: CompletionEnvelope }
    | { type: 'resume'; fileId: string }
    | { type: 'cancel' }
    | { type: 'connectivity'; online: boolean };

export type WorkerToClient =
    | { type: 'progress'; bytesSent: number; totalBytes: number }
    | { type: 'retry' }
    | { type: 'cancelled' } // cancel ack — worker has aborted XHRs + called server abort
    | { type: 'error'; message: string; retryable: boolean }
    | { type: 'done'; actualSize: number };
