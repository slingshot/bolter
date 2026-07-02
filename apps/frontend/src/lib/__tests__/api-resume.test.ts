import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeUpload } from '@/lib/api';
import type { PersistedUpload } from '@/lib/upload-state';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Minimal XMLHttpRequest fake for the part-upload path: succeeds immediately
 * with an ETag header. Captures sent bodies so tests can assert on them.
 */
class FakeXHR {
    static DONE = 4;
    static sentBodies: Blob[] = [];

    readyState = 4;
    status = 200;
    statusText = 'OK';
    responseText = '';
    upload = {
        addEventListener: () => {
            /* progress events not simulated */
        },
    };
    private listeners: Record<string, Array<() => void>> = {};

    addEventListener(event: string, fn: () => void) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(fn);
    }

    getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'etag' ? '"fake-etag"' : null;
    }

    open() {
        /* noop */
    }

    abort() {
        /* noop */
    }

    send(body: Blob) {
        FakeXHR.sentBodies.push(body);
        queueMicrotask(() => {
            for (const fn of this.listeners.loadend ?? []) {
                fn();
            }
        });
    }
}

interface RecordedRequest {
    url: string;
    body: Record<string, unknown> | null;
}

function makeState(overrides: Partial<PersistedUpload> = {}): PersistedUpload {
    return {
        version: 2,
        fileId: 'resume-file-id',
        uploadId: 'resume-upload-id',
        ownerToken: 'owner-token',
        fileName: 'test.bin',
        fileSize: 20_000_000,
        fileLastModified: 1700000000000,
        encrypted: false,
        partSize: 10_000_000,
        plaintextPartSize: 10_000_000,
        completedParts: [
            { PartNumber: 1, ETag: '"etag1"' },
            { PartNumber: 2, ETag: '"etag2"' },
        ],
        totalParts: 2,
        timeLimit: 86400,
        downloadLimit: 1,
        createdAt: Date.now(),
        ...overrides,
    };
}

describe('resumeUpload', () => {
    let requests: RecordedRequest[];
    let resumeResponse: Record<string, unknown>;

    beforeEach(() => {
        requests = [];
        FakeXHR.sentBodies = [];
        vi.stubGlobal('XMLHttpRequest', FakeXHR);
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit) => {
                const body = init?.body ? JSON.parse(init.body as string) : null;
                requests.push({ url: String(url), body });
                if (String(url).includes('/resume')) {
                    return Promise.resolve(
                        new Response(JSON.stringify(resumeResponse), { status: 200 }),
                    );
                }
                if (String(url).includes('/upload/complete')) {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({ success: true, id: 'resume-file-id', url: 'x' }),
                            { status: 200 },
                        ),
                    );
                }
                return Promise.reject(new Error(`Unexpected fetch: ${url}`));
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('completes directly when every part was already uploaded', async () => {
        // Interrupted between the last part upload and /upload/complete:
        // the server has all parts, so resume must finalize without streaming.
        resumeResponse = { parts: [], partSize: 10_000_000, numParts: 2 };
        const file = new File([new Uint8Array(20_000_000)], 'test.bin', {
            lastModified: 1700000000000,
        });

        const result = await resumeUpload(file, makeState());

        expect(result.id).toBe('resume-file-id');
        const completeReq = requests.find((r) => r.url.includes('/upload/complete'));
        expect(completeReq).toBeDefined();
        const parts = completeReq?.body?.parts as Array<{ PartNumber: number }>;
        expect(parts.map((p) => p.PartNumber)).toEqual([1, 2]);
        // No part data may be re-uploaded
        expect(FakeXHR.sentBodies.length).toBe(0);
    });

    it('uploads a small trailing part instead of falling back to single-part', async () => {
        // Only the sub-5MiB trailing part remains. A small trailing part is
        // legal in S3/R2 because prior parts exist — the single-part fallback
        // must not trigger during resume.
        resumeResponse = {
            parts: [
                {
                    partNumber: 3,
                    url: 'https://s3.example.com/part3',
                    minSize: 0,
                    maxSize: 10_000_000,
                },
            ],
            partSize: 10_000_000,
            numParts: 3,
        };
        const file = new File([new Uint8Array(21_000_000)], 'test.bin', {
            lastModified: 1700000000000,
        });

        const result = await resumeUpload(file, makeState({ fileSize: 21_000_000, totalParts: 3 }));

        expect(result.id).toBe('resume-file-id');
        // The 1MB tail was uploaded as part 3
        expect(FakeXHR.sentBodies.length).toBe(1);
        expect(FakeXHR.sentBodies[0].size).toBe(1_000_000);
        const completeReq = requests.find((r) => r.url.includes('/upload/complete'));
        const parts = completeReq?.body?.parts as Array<{ PartNumber: number; ETag: string }>;
        expect(parts.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
        expect(parts[2].ETag).toBe('"fake-etag"');
    });
});
