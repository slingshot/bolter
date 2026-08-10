/**
 * Error thrown when a file becomes unreadable during upload
 * (e.g., file was moved, deleted, or disk became unavailable)
 */
export class FileReadError extends Error {
    constructor(filename: string, cause: unknown) {
        super(
            `Could not read "${filename}". The file may have been moved, deleted, or is no longer accessible. Please re-add the file and try again.`,
        );
        this.name = 'FileReadError';
        this.cause = cause;
    }
}

/**
 * Thrown when a file has already been downloaded its maximum number of times.
 *
 * `/download/url/:id` deliberately answers with a soft 200 carrying `dl` and
 * `dlimit` at the limit (see AGENTS.md), so the client — not the transport —
 * is responsible for turning that into a terminal, non-retryable condition.
 * Consumers distinguish it by `name` so it survives module duplication.
 */
export class LimitReachedError extends Error {
    constructor(message = 'This file has reached its download limit and is no longer available.') {
        super(message);
        this.name = 'LimitReachedError';
    }
}
