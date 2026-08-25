/**
 * The `--json` contract.
 *
 * Two rules make this usable by a program: stdout carries exactly one JSON
 * object and nothing else, and the envelope is versioned so a consumer can
 * tell when its assumptions stop holding. Everything a human would want —
 * progress, warnings, hints — goes to stderr, where it cannot corrupt a pipe.
 */

import type { ErrorCode, SendfmError } from '../core/errors';

/** Bumped only if the envelope's own shape changes incompatibly. */
export const ENVELOPE_VERSION = 1;

export interface EnvelopeWarning {
    code: string;
    message: string;
}

export interface SuccessEnvelope<T> {
    sendfm: number;
    ok: true;
    command: string;
    data: T;
    warnings: EnvelopeWarning[];
}

export interface ErrorEnvelope {
    sendfm: number;
    ok: false;
    command: string;
    error: {
        code: ErrorCode;
        message: string;
        retryable: boolean;
        hint?: string;
        details?: Record<string, unknown>;
    };
    warnings: EnvelopeWarning[];
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function successEnvelope<T>(
    command: string,
    data: T,
    warnings: EnvelopeWarning[] = [],
): SuccessEnvelope<T> {
    return { sendfm: ENVELOPE_VERSION, ok: true, command, data, warnings };
}

export function errorEnvelope(
    command: string,
    error: SendfmError,
    warnings: EnvelopeWarning[] = [],
): ErrorEnvelope {
    return {
        sendfm: ENVELOPE_VERSION,
        ok: false,
        command,
        error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.hint ? { hint: error.hint } : {}),
            ...(error.details ? { details: error.details } : {}),
        },
        warnings,
    };
}
