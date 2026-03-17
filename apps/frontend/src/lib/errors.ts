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
