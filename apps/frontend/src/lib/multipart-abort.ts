/**
 * Best-effort abort of a server-side multipart upload.
 *
 * Discarding a resumable upload locally (IndexedDB) is not enough: `/upload/url`
 * created the S3 multipart and incremented the provider file counter, and only
 * `/upload/abort/:id` releases them. Without this call the uploaded parts stay
 * billable forever and the provider file counter drifts upward permanently.
 *
 * NOTE: `api.ts` has an equivalent private `abortMultipartUpload` helper that is
 * not exported. This module deliberately avoids importing from `api.ts` because
 * `api.ts` imports `upload-state.ts`, and `upload-state.ts` needs this helper —
 * routing through `api.ts` would create an import cycle.
 */

// Mirrors `API_BASE_URL` in `api.ts` (kept local to avoid the import cycle above).
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Ask the server to abort a multipart upload. Never throws — cleanup paths must
 * make progress even when the backend is unreachable.
 *
 * `/upload/abort/:id` answers HTTP 200 with `{ error }` when the abort fails
 * (missing uploadId, S3 rejection), so the status code alone over-reports
 * success; the body's `success` flag is the real signal.
 *
 * @returns true when the server confirmed the abort.
 */
export async function abortServerMultipart(
    fileId: string,
    uploadId: string,
    uploadToken?: string,
): Promise<boolean> {
    if (!fileId || !uploadId) {
        return false;
    }
    try {
        const response = await fetch(`${API_BASE_URL}/upload/abort/${fileId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // uploadToken authorizes the abort (audit #52). Omitted for records
            // persisted before it existed; the backend accepts those.
            body: JSON.stringify(uploadToken ? { uploadId, uploadToken } : { uploadId }),
        });
        if (!response.ok) {
            return false;
        }
        const body = (await response.json().catch(() => null)) as { success?: unknown } | null;
        return body?.success === true;
    } catch {
        // Offline / DNS / CORS — the local record is still discarded by the caller.
        return false;
    }
}
