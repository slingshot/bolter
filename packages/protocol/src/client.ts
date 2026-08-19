/**
 * Typed client for the Bolter HTTP API.
 *
 * A factory rather than module-level functions because the base URL is not a
 * build-time constant outside the browser: the CLI talks to whichever instance
 * a share link came from, and may talk to two in one process.
 *
 * The `send-v1` challenge-retry lives here, once. It was previously written
 * out by hand at every authenticated call site — five copies of "read
 * WWW-Authenticate, re-sign, retry, then harvest the rotated nonce" — and
 * each copy was an opportunity to forget the harvest, which silently breaks
 * the *next* request rather than this one.
 */

import type { PartPlanEntry } from './parts';

/**
 * Structural, so a `Keychain` satisfies it without this module importing
 * crypto — and so a test can authenticate with a stub.
 */
export interface Authenticator {
    nonce: string;
    authHeader(): Promise<string>;
}

/**
 * Structural rather than `typeof globalThis.fetch`: Bun's fetch carries extra
 * properties (`preconnect`) that a caller injecting a stub has no reason to
 * supply, and requiring them would make the seam unusable.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface BolterClientOptions {
    /** API origin, no trailing slash. */
    baseUrl: string;
    /** Injectable for tests, proxies and instrumentation. */
    fetch?: FetchLike;
}

export interface UploadUrlRequest {
    /** Size of the bytes that will be PUT — ciphertext size when encrypted. */
    fileSize: number;
    encrypted?: boolean;
    timeLimit?: number;
    dlimit?: number;
}

export interface UploadPartUrl {
    partNumber: number;
    url: string;
    minSize: number;
    maxSize: number;
}

export interface UploadUrlResponse {
    useSignedUrl?: boolean;
    multipart?: boolean;
    id?: string;
    owner?: string;
    uploadToken?: string;
    uploadId?: string;
    parts?: UploadPartUrl[];
    partSize?: number;
    url?: string | null;
    completeUrl?: string;
    error?: string;
}

export interface CompletedPart {
    PartNumber: number;
    ETag: string;
}

export interface CompleteUploadRequest {
    id: string;
    metadata?: string;
    authKey?: string;
    actualSize?: number;
    parts?: CompletedPart[];
}

export interface CompleteUploadResponse {
    success?: boolean;
    id?: string;
    /** Download URL with no fragment — the key never leaves the client. */
    url?: string;
    /**
     * Authoritative expiry. The TTL starts when the upload URL is issued, not
     * at completion, so a long or resumed upload has materially less lifetime
     * left than `timeLimit` suggests and a client must not compute it itself.
     */
    expiresAt?: number;
    ttl?: number;
}

export interface ResumeMultipartResponse {
    parts: UploadPartUrl[];
    partSize: number;
    numParts: number;
}

/** What `GET /config` returns: an instance's limits, defaults and UI strings. */
export interface InstanceConfig {
    LIMITS: {
        MAX_FILE_SIZE: number;
        MAX_FILES_PER_ARCHIVE: number;
        MAX_EXPIRE_SECONDS: number;
        MAX_DOWNLOADS: number;
    };
    DEFAULTS: {
        EXPIRE_SECONDS: number;
        DOWNLOADS: number;
    };
    UI: {
        TITLE: string;
        DESCRIPTION: string;
        EXPIRE_TIMES: number[];
        DOWNLOAD_COUNTS: number[];
    };
}

export interface RawMetadataResponse {
    metadata: string;
    ttl: number;
    encrypted: boolean;
}

export type DownloadStatus =
    | { status: 'ok'; dl: number; dlimit: number; url?: string }
    | { status: 'gone' }
    | { status: 'error' };

export type FileInfo =
    | { status: 'ok'; dl: number; dlimit: number; ttl: number }
    | { status: 'not_found' }
    | { status: 'error' };

export class BolterApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly path: string,
    ) {
        super(message);
        this.name = 'BolterApiError';
    }
}

/** Read the rotated nonce the server echoes on every authenticated response. */
function harvestNonce(response: Response, auth: Authenticator | null): void {
    if (!auth) {
        return;
    }
    const header = response.headers.get('WWW-Authenticate');
    const nonce = header?.split(' ')[1];
    if (nonce) {
        auth.nonce = nonce;
    }
}

export interface BolterClient {
    readonly baseUrl: string;
    getConfig(): Promise<InstanceConfig>;
    exists(id: string): Promise<boolean>;
    getRawMetadata(id: string, auth?: Authenticator | null): Promise<RawMetadataResponse>;
    getDownloadStatus(id: string, auth?: Authenticator | null): Promise<DownloadStatus>;
    getDownloadUrl(id: string, auth?: Authenticator | null): Promise<DownloadStatus>;
    reportDownloadComplete(id: string, auth?: Authenticator | null): Promise<boolean>;
    requestUploadUrl(body: UploadUrlRequest): Promise<UploadUrlResponse>;
    completeUpload(body: CompleteUploadRequest): Promise<CompleteUploadResponse>;
    abortUpload(id: string, uploadId: string, uploadToken?: string): Promise<boolean>;
    resumeMultipart(
        id: string,
        uploadId: string,
        completedPartNumbers: number[],
        uploadToken?: string,
    ): Promise<ResumeMultipartResponse>;
    getFileInfo(id: string, ownerToken: string): Promise<FileInfo>;
    deleteFile(id: string, ownerToken: string): Promise<boolean>;
    setParams(id: string, ownerToken: string, params: { dlimit?: number }): Promise<boolean>;
    setPassword(id: string, ownerToken: string, authKey: string): Promise<boolean>;
}

export function createBolterClient(options: BolterClientOptions): BolterClient {
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    /**
     * Resolved per call, not captured at construction. Snapshotting
     * `globalThis.fetch` would silently bypass any wrapper a host installs
     * afterwards — instrumentation, a proxy, a test double — and the call
     * must go through `globalThis` so the receiver stays correct.
     */
    const doFetch: FetchLike = (input, init) =>
        options.fetch ? options.fetch(input, init) : globalThis.fetch(input, init);

    /**
     * One authenticated request, with the single challenge-retry the protocol
     * requires. The nonce rotates only on a *successful* auth, by
     * compare-and-swap, so two concurrent successes mean one loses and gets a
     * 401 with a fresh challenge — the retry is what absorbs that, and it is
     * safe precisely because a 401 proves the request had no effect.
     */
    async function authed(
        path: string,
        init: RequestInit,
        auth: Authenticator | null | undefined,
    ): Promise<Response> {
        const send = async (): Promise<Response> => {
            const headers: Record<string, string> = {
                ...((init.headers as Record<string, string> | undefined) ?? {}),
            };
            if (auth) {
                headers.Authorization = await auth.authHeader();
            }
            return doFetch(`${baseUrl}${path}`, { ...init, headers });
        };

        let response = await send();
        if (response.status === 401 && auth) {
            const nonce = response.headers.get('WWW-Authenticate')?.split(' ')[1];
            if (nonce) {
                auth.nonce = nonce;
                response = await send();
            }
        }
        harvestNonce(response, auth ?? null);
        return response;
    }

    async function json<T>(response: Response, path: string): Promise<T> {
        if (!response.ok) {
            throw new BolterApiError(`HTTP ${response.status}`, response.status, path);
        }
        return (await response.json()) as T;
    }

    return {
        baseUrl,

        async getConfig() {
            return json<InstanceConfig>(await doFetch(`${baseUrl}/config`), '/config');
        },

        async exists(id) {
            const response = await doFetch(`${baseUrl}/exists/${id}`);
            if (!response.ok) {
                return false;
            }
            const data = (await response.json()) as { exists: boolean };
            return data.exists;
        },

        async getRawMetadata(id, auth) {
            const path = `/metadata/${id}`;
            return json<RawMetadataResponse>(await authed(path, {}, auth), path);
        },

        getDownloadStatus(id, auth) {
            return this.getDownloadUrl(id, auth);
        },

        /**
         * Also the download-status probe: the route reports `dl`/`dlimit`
         * without incrementing anything, and returns `useSignedUrl: false`
         * rather than 410 once the limit is reached.
         */
        async getDownloadUrl(id, auth) {
            try {
                const response = await authed(`/download/url/${id}`, {}, auth);
                if (response.status === 404 || response.status === 410) {
                    return { status: 'gone' };
                }
                if (!response.ok) {
                    return { status: 'error' };
                }
                const data = (await response.json()) as {
                    useSignedUrl: boolean;
                    url?: string;
                    dl: number;
                    dlimit: number;
                };
                return { status: 'ok', dl: data.dl, dlimit: data.dlimit, url: data.url };
            } catch {
                // A network failure is not an exhausted download limit, and
                // rendering it as one tells the user their file is gone.
                return { status: 'error' };
            }
        },

        /**
         * Never blind-retries on a network error: the increment is not
         * idempotent, so a lost response may already have counted. Only a 401
         * is retried, because a 401 proves nothing happened.
         */
        async reportDownloadComplete(id, auth) {
            try {
                const response = await authed(`/download/complete/${id}`, { method: 'POST' }, auth);
                return response.ok;
            } catch {
                return false;
            }
        },

        async requestUploadUrl(body) {
            const path = '/upload/url';
            const response = await doFetch(`${baseUrl}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return json<UploadUrlResponse>(response, path);
        },

        async completeUpload(body) {
            const path = '/upload/complete';
            const response = await doFetch(`${baseUrl}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                throw new BolterApiError(
                    `Failed to complete upload: ${await response.text()}`,
                    response.status,
                    path,
                );
            }
            return (await response.json()) as CompleteUploadResponse;
        },

        async abortUpload(id, uploadId, uploadToken) {
            const response = await doFetch(`${baseUrl}/upload/abort/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId, uploadToken }),
            });
            return response.ok;
        },

        async resumeMultipart(id, uploadId, completedPartNumbers, uploadToken) {
            const path = `/upload/multipart/${id}/resume`;
            const response = await doFetch(`${baseUrl}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId, uploadToken, completedPartNumbers }),
            });
            return json<ResumeMultipartResponse>(response, path);
        },

        async getFileInfo(id, ownerToken) {
            try {
                const response = await doFetch(`${baseUrl}/info/${id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ owner_token: ownerToken }),
                });
                if (response.status === 404) {
                    return { status: 'not_found' };
                }
                if (!response.ok) {
                    return { status: 'error' };
                }
                const data = (await response.json()) as {
                    dl: number;
                    dlimit: number;
                    ttl: number;
                };
                return { status: 'ok', ...data };
            } catch {
                return { status: 'error' };
            }
        },

        async deleteFile(id, ownerToken) {
            const response = await doFetch(`${baseUrl}/delete/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ owner_token: ownerToken }),
            });
            return response.ok;
        },

        /** `/params/:id` accepts `dlimit` and nothing else — expiry is fixed at creation. */
        async setParams(id, ownerToken, params) {
            const response = await doFetch(`${baseUrl}/params/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ owner_token: ownerToken, ...params }),
            });
            return response.ok;
        },

        async setPassword(id, ownerToken, authKey) {
            const response = await doFetch(`${baseUrl}/password/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ owner_token: ownerToken, auth: authKey }),
            });
            return response.ok;
        },
    };
}

/** Re-exported so callers can type a part plan against the signed URLs. */
export type { PartPlanEntry };
