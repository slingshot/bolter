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
    /** `atMs` is the *producer's* `Date.now()` — the moment the worker
     * observed these bytes, not the moment the main thread got around to
     * handling the message. A busy main thread drains queued progress
     * messages milliseconds apart; timing a rate by delivery would divide a
     * real byte delta by a phantom gap. Additive: consumers must tolerate its
     * absence. */
    | { type: 'progress'; bytesSent: number; totalBytes: number; atMs?: number }
    | { type: 'retry' }
    | { type: 'cancelled' } // cancel ack — worker has aborted XHRs + called server abort
    /**
     * `name`/`stack` are the worker-side error's own, carried across the
     * boundary because structured clone does not preserve an Error's class
     * and the facade rethrows every failure from one place. Sentry groups on
     * the stack, so without them an OPFS rename fault, a transport timeout
     * and a completion rejection all collapse into a single issue. Additive:
     * consumers must tolerate their absence.
     */
    | {
          type: 'error';
          message: string;
          retryable: boolean;
          stage?: EngineFailureStage;
          name?: string;
          stack?: string;
      }
    | { type: 'done'; actualSize: number };

/**
 * Internal eligibility-probe handshake (`probeEligibility`), sent to a
 * throwaway worker before any job starts — additive to the job protocol
 * above, never mixed into a running upload's message stream.
 */
export type EngineProbeRequest = { type: 'probe' };
export type EngineProbeResult = { type: 'probe-result'; ok: boolean; reason?: string };
