/**
 * HTTP client for all Bolter backend interactions.
 * Uses native fetch() (available in Bun).
 */

import { b64ToArray, type Keychain } from './crypto';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface ServerConfig {
    maxFileSize: number;
    maxExpireSeconds: number;
    defaultExpireSeconds: number;
    defaultDownloads: number;
    expireTimesSeconds: number[];
    downloadCounts: number[];
}

export interface FileMetadata {
    name: string;
    size: number;
    type: string;
    files: { name: string; size: number; type: string }[];
    zipped?: boolean;
    zipFilename?: string;
    ttl: number;
    encrypted: boolean;
}

export interface UploadUrlParams {
    fileSize: number;
    encrypted?: boolean;
    timeLimit?: number;
    dlimit?: number;
    preferredPartSize?: number;
}

export interface UploadUrlResponse {
    useSignedUrl: boolean;
    multipart: boolean;
    id: string;
    owner: string;
    url: string;
    uploadId?: string;
    parts?: { partNumber: number; url: string; minSize: number; maxSize: number }[];
    partSize?: number;
}

export interface CompleteUploadParams {
    id: string;
    metadata: string;
    authKey?: string;
    actualSize?: number;
    parts?: { PartNumber: number; ETag: string }[];
}

export interface ResumeParams {
    uploadId: string;
    completedPartNumbers: number[];
}

export interface ResumeResponse {
    parts: { partNumber: number; url: string; minSize: number; maxSize: number }[];
    partSize: number;
    numParts: number;
}

export interface DownloadUrlResult {
    useSignedUrl: boolean;
    url?: string;
    dl: number;
    dlimit: number;
}

export interface SpeedTestResult {
    testId: string;
    uploadId: string;
    parts: { partNumber: number; url: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a full URL from a server base and a path.
 */
function buildUrl(server: string, path: string): string {
    const base = server.replace(/\/+$/, '');
    return `${base}${path}`;
}

/**
 * Extract a nonce from a `WWW-Authenticate: send-v1 <nonce>` header.
 */
function extractNonce(header: string | null): string | null {
    if (!header) {
        return null;
    }
    const match = header.match(/^send-v1\s+(.+)$/i);
    return match ? match[1] : null;
}

/**
 * Perform a fetch with challenge-response authentication.
 *
 * 1. If keychain has a nonce, include an Authorization header on the first try.
 * 2. On 401, extract the nonce from WWW-Authenticate, set it on the keychain,
 *    and retry with a fresh Authorization header.
 * 3. On success, extract a nonce from the response for future requests.
 */
async function fetchWithAuth(
    url: string,
    keychain?: Keychain,
    options: RequestInit = {},
): Promise<Response> {
    const makeHeaders = async (): Promise<HeadersInit> => {
        const headers: Record<string, string> = {
            ...(options.headers as Record<string, string> | undefined),
        };
        if (keychain?.nonce) {
            headers.Authorization = await keychain.authHeader();
        }
        return headers;
    };

    // First attempt
    let response = await fetch(url, {
        ...options,
        headers: await makeHeaders(),
    });

    // Challenge-response: handle 401
    if (response.status === 401 && keychain) {
        const wwwAuth = response.headers.get('WWW-Authenticate');
        const nonce = extractNonce(wwwAuth);
        if (nonce) {
            keychain.nonce = nonce;
            response = await fetch(url, {
                ...options,
                headers: await makeHeaders(),
            });
        }
    }

    // Extract nonce from successful response for future requests
    if (response.ok && keychain) {
        const wwwAuth = response.headers.get('WWW-Authenticate');
        const nonce = extractNonce(wwwAuth);
        if (nonce) {
            keychain.nonce = nonce;
        }
    }

    return response;
}

/**
 * Throw a descriptive error for non-OK responses.
 */
async function assertOk(response: Response, context: string): Promise<void> {
    if (!response.ok) {
        let body: string;
        try {
            body = await response.text();
        } catch {
            body = '(could not read response body)';
        }
        throw new Error(`${context}: ${response.status} ${response.statusText} — ${body}`);
    }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch server configuration.
 * GET /config
 */
export async function getServerConfig(server: string): Promise<ServerConfig> {
    const response = await fetch(buildUrl(server, '/config'));
    await assertOk(response, 'getServerConfig');
    return response.json() as Promise<ServerConfig>;
}

/**
 * Check whether a file exists on the server.
 * GET /exists/:id
 */
export async function checkExists(server: string, id: string): Promise<boolean> {
    const response = await fetch(buildUrl(server, `/exists/${encodeURIComponent(id)}`));
    await assertOk(response, 'checkExists');
    const data = (await response.json()) as { exists: boolean };
    return data.exists;
}

/**
 * Fetch file metadata, handling challenge-response auth for encrypted files.
 * GET /metadata/:id
 *
 * For encrypted files the metadata payload is itself encrypted; the keychain
 * is used both for auth and to decrypt the metadata blob.
 */
export async function getMetadata(
    server: string,
    id: string,
    keychain?: Keychain,
): Promise<FileMetadata> {
    const url = buildUrl(server, `/metadata/${encodeURIComponent(id)}`);
    const response = await fetchWithAuth(url, keychain);
    await assertOk(response, 'getMetadata');

    const data = (await response.json()) as {
        metadata: string;
        encrypted: boolean;
        ttl: number;
        [key: string]: unknown;
    };

    // biome-ignore lint/suspicious/noExplicitAny: metadata shape is dynamic
    let raw: any;

    if (data.encrypted && keychain) {
        // Metadata is encrypted — decrypt with keychain
        raw = await keychain.decryptMetadata(b64ToArray(data.metadata));
    } else {
        // Metadata is base64-encoded JSON
        const decoded = new TextDecoder().decode(b64ToArray(data.metadata));
        raw = JSON.parse(decoded);
    }

    // Extract first file info for convenience (matching frontend behavior)
    const firstFile = raw.files?.[0];

    const meta: FileMetadata = {
        name: firstFile?.name || raw.name || 'download',
        size: firstFile?.size || raw.size || 0,
        type: firstFile?.type || raw.type || 'application/octet-stream',
        files: raw.files || [],
        zipped: raw.zipped,
        zipFilename: raw.zipFilename,
        ttl: data.ttl,
        encrypted: data.encrypted,
    };

    return meta;
}

/**
 * Get a pre-signed download URL.
 * GET /download/url/:id
 */
export async function getDownloadUrl(
    server: string,
    id: string,
    keychain?: Keychain,
): Promise<DownloadUrlResult> {
    const url = buildUrl(server, `/download/url/${encodeURIComponent(id)}`);
    const response = await fetchWithAuth(url, keychain);
    await assertOk(response, 'getDownloadUrl');
    return response.json() as Promise<DownloadUrlResult>;
}

/**
 * Report that a download has completed (decrements download counter).
 * POST /download/complete/:id
 */
export async function reportDownloadComplete(
    server: string,
    id: string,
    keychain?: Keychain,
): Promise<void> {
    const url = buildUrl(server, `/download/complete/${encodeURIComponent(id)}`);
    const response = await fetchWithAuth(url, keychain, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    await assertOk(response, 'reportDownloadComplete');
}

/**
 * Request pre-signed upload URL(s) from the server.
 * POST /upload/url
 */
export async function requestUploadUrl(
    server: string,
    params: UploadUrlParams,
): Promise<UploadUrlResponse> {
    const response = await fetch(buildUrl(server, '/upload/url'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
    await assertOk(response, 'requestUploadUrl');
    return response.json() as Promise<UploadUrlResponse>;
}

/**
 * Complete a file upload (finalize multipart, store metadata).
 * POST /upload/complete
 */
export async function completeUpload(server: string, params: CompleteUploadParams): Promise<void> {
    const response = await fetch(buildUrl(server, '/upload/complete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
    await assertOk(response, 'completeUpload');
}

/**
 * Resume an interrupted multipart upload.
 * POST /upload/multipart/:id/resume
 */
export async function resumeUpload(
    server: string,
    id: string,
    params: ResumeParams,
): Promise<ResumeResponse> {
    const response = await fetch(
        buildUrl(server, `/upload/multipart/${encodeURIComponent(id)}/resume`),
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
        },
    );
    await assertOk(response, 'resumeUpload');
    return response.json() as Promise<ResumeResponse>;
}

/**
 * Abort a multipart upload.
 * POST /upload/abort/:id
 */
export async function abortUpload(server: string, id: string, uploadId: string): Promise<void> {
    const response = await fetch(buildUrl(server, `/upload/abort/${encodeURIComponent(id)}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
    });
    await assertOk(response, 'abortUpload');
}

/**
 * Start a speed test — returns pre-signed URLs for test uploads.
 * POST /upload/speedtest
 */
export async function runSpeedTest(server: string): Promise<SpeedTestResult> {
    const response = await fetch(buildUrl(server, '/upload/speedtest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    await assertOk(response, 'runSpeedTest');
    return response.json() as Promise<SpeedTestResult>;
}

/**
 * Clean up speed test objects from S3.
 * POST /upload/speedtest/cleanup
 */
export async function cleanupSpeedTest(
    server: string,
    testId: string,
    uploadId?: string,
): Promise<void> {
    const response = await fetch(buildUrl(server, '/upload/speedtest/cleanup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId, uploadId }),
    });
    await assertOk(response, 'cleanupSpeedTest');
}

/**
 * Upload a single part to a pre-signed S3 URL.
 * PUT to the URL; returns the ETag from the response header.
 */
export async function uploadPart(
    url: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    contentLength: number,
    signal?: AbortSignal,
): Promise<string> {
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Content-Length': String(contentLength),
        },
        body: body as BodyInit,
        signal,
    });

    if (!response.ok) {
        throw new Error(`uploadPart: ${response.status} ${response.statusText}`);
    }

    const etag = response.headers.get('ETag');
    if (!etag) {
        throw new Error('uploadPart: response missing ETag header');
    }

    return etag;
}
