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

/**
 * Which pipeline leg a terminal engine failure came from — the spec's
 * "engine failure (stage)" telemetry dimension [R16]. Without it, OPFS quota
 * exhaustion, transport failures, and completion rejections are
 * telemetrically identical. Additive: consumers must tolerate its absence.
 */
export type EngineFailureStage =
    | 'staging' // producer/stager leg (reads, encryption, OPFS writes)
    | 'stager-quota' // OPFS quota exhaustion while staging
    | 'uploader' // part transport (XHR) leg
    | 'completion' // /upload/complete + validation
    | 'resume' // resume planning (need-source / unrecoverable)
    | 'engine'; // setup/dispatch faults outside a specific leg

export type WorkerToClient =
    | { type: 'progress'; bytesSent: number; totalBytes: number }
    | { type: 'retry' }
    | { type: 'cancelled' } // cancel ack — worker has aborted XHRs + called server abort
    | { type: 'error'; message: string; retryable: boolean; stage?: EngineFailureStage }
    | { type: 'done'; actualSize: number };

/**
 * Internal eligibility-probe handshake (`probeEligibility`), sent to a
 * throwaway worker before any job starts — additive to the job protocol
 * above, never mixed into a running upload's message stream.
 */
export type EngineProbeRequest = { type: 'probe' };
export type EngineProbeResult = { type: 'probe-result'; ok: boolean; reason?: string };
