/**
 * Typed failures, with one place that decides how each is reported.
 *
 * A CLI's error taxonomy is an API: scripts branch on exit codes and agents
 * branch on the machine-readable code, so both have to be stable and both have
 * to mean the same thing. Deriving them from one error class is what keeps
 * them from drifting apart.
 */

/**
 * Process exit codes. Deliberately coarse — a caller can distinguish "the
 * network gave up" from "the link is dead" without parsing anything, and
 * anything finer belongs in the JSON error code.
 */
export const EXIT = {
    OK: 0,
    /** Anything with no better classification. */
    GENERAL: 1,
    /** Bad flags, bad arguments, a file that is not there. */
    USAGE: 2,
    /** Retries exhausted, host unreachable, transfer could not finish. */
    NETWORK: 3,
    /** Wrong decryption key, wrong owner token, rejected challenge. */
    AUTH: 4,
    /** Expired, deleted, or out of downloads. */
    GONE: 5,
    /** The instance speaks a protocol this build cannot. */
    INCOMPATIBLE: 6,
    /** Local state or filesystem problem — not the server's fault. */
    LOCAL: 7,
    /** Ctrl-C. 130 is the shell convention for SIGINT. */
    INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type ErrorCode =
    | 'USAGE'
    | 'FILE_NOT_FOUND'
    | 'FILE_TOO_LARGE'
    | 'TOO_MANY_FILES'
    | 'INVALID_SHARE_URL'
    | 'INSTANCE_UNREACHABLE'
    | 'INSTANCE_INCOMPATIBLE'
    | 'NETWORK'
    | 'UPLOAD_FAILED'
    | 'DOWNLOAD_FAILED'
    | 'MISSING_KEY'
    | 'INVALID_KEY'
    | 'NOT_OWNER'
    | 'GONE'
    | 'LOCAL_STATE'
    | 'CANCELLED'
    | 'INTERNAL';

const EXIT_FOR: Record<ErrorCode, ExitCode> = {
    USAGE: EXIT.USAGE,
    FILE_NOT_FOUND: EXIT.USAGE,
    FILE_TOO_LARGE: EXIT.USAGE,
    TOO_MANY_FILES: EXIT.USAGE,
    INVALID_SHARE_URL: EXIT.USAGE,
    INSTANCE_UNREACHABLE: EXIT.NETWORK,
    INSTANCE_INCOMPATIBLE: EXIT.INCOMPATIBLE,
    NETWORK: EXIT.NETWORK,
    UPLOAD_FAILED: EXIT.NETWORK,
    DOWNLOAD_FAILED: EXIT.NETWORK,
    MISSING_KEY: EXIT.AUTH,
    INVALID_KEY: EXIT.AUTH,
    NOT_OWNER: EXIT.AUTH,
    GONE: EXIT.GONE,
    LOCAL_STATE: EXIT.LOCAL,
    CANCELLED: EXIT.INTERRUPTED,
    INTERNAL: EXIT.GENERAL,
};

export interface SendfmErrorOptions {
    /** Machine-readable detail. Must not contain secrets or signed URLs. */
    details?: Record<string, unknown>;
    /** True when trying again unchanged could plausibly work. */
    retryable?: boolean;
    /** One line telling the user what to do about it. */
    hint?: string;
    cause?: unknown;
}

export class SendfmError extends Error {
    readonly code: ErrorCode;
    readonly details?: Record<string, unknown>;
    readonly retryable: boolean;
    readonly hint?: string;

    constructor(code: ErrorCode, message: string, options: SendfmErrorOptions = {}) {
        super(message, { cause: options.cause });
        this.name = 'SendfmError';
        this.code = code;
        this.details = options.details;
        this.retryable = options.retryable ?? false;
        this.hint = options.hint;
    }

    get exitCode(): ExitCode {
        return EXIT_FOR[this.code];
    }
}

/** Narrow an unknown thrown value to something reportable. */
export function toSendfmError(error: unknown): SendfmError {
    if (error instanceof SendfmError) {
        return error;
    }
    if (error instanceof Error) {
        // Ctrl-C surfaces as an abort, and reporting it as a crash would put a
        // stack trace in front of someone who simply changed their mind.
        if (error.name === 'AbortError') {
            return new SendfmError('CANCELLED', 'Cancelled.', { cause: error });
        }
        return new SendfmError('INTERNAL', error.message, { cause: error });
    }
    return new SendfmError('INTERNAL', String(error));
}
