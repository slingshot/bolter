import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeUpload } from '@/lib/api';
import { computeContentFingerprint, type PersistedUpload } from '@/lib/upload-state';

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

    beforeEach(async () => {
        // Persisted resume state is per-test — start from an empty database
        await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase('bolter-uploads');
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
        });
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

        const result = await resumeUpload(
            file,
            makeState({ contentFingerprint: await computeContentFingerprint(file) }),
        );

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

        const result = await resumeUpload(
            file,
            makeState({
                fileSize: 21_000_000,
                totalParts: 3,
                contentFingerprint: await computeContentFingerprint(file),
            }),
        );

        expect(result.id).toBe('resume-file-id');
        // The 1MB tail was uploaded as part 3
        expect(FakeXHR.sentBodies.length).toBe(1);
        expect(FakeXHR.sentBodies[0].size).toBe(1_000_000);
        const completeReq = requests.find((r) => r.url.includes('/upload/complete'));
        const parts = completeReq?.body?.parts as Array<{ PartNumber: number; ETag: string }>;
        expect(parts.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
        expect(parts[2].ETag).toBe('"fake-etag"');
    });

    // ---------------------------------------------------------------------
    // Finding 46 — resume must report the true byte count, not allocated
    // capacity (totalParts × partSize), which overstates size for essentially
    // every resumed upload and makes downloads log spurious size mismatches.
    // ---------------------------------------------------------------------
    it('completes with the true uploaded byte count, not allocated capacity', async () => {
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

        await resumeUpload(
            file,
            makeState({
                fileSize: 21_000_000,
                totalParts: 3,
                contentFingerprint: await computeContentFingerprint(file),
            }),
        );

        const completeReq = requests.find((r) => r.url.includes('/upload/complete'));
        // 2 completed parts × 10MB + a 1MB tail. The pre-fix code sent
        // totalParts × partSize = 30,000,000.
        expect(completeReq?.body?.actualSize).toBe(21_000_000);
    });

    it('reports the true size when the completed prefix already covers the file', async () => {
        // Interrupted between the LAST part upload and /upload/complete: the
        // resume endpoint hands back no parts, so there is nothing to stream and
        // no measured byte count to add. Deriving the size from the part grid
        // counts the partial trailing part (1MB) as a whole 10MB part.
        resumeResponse = { parts: [], partSize: 10_000_000, numParts: 3 };
        const file = new File([new Uint8Array(21_000_000)], 'test.bin', {
            lastModified: 1700000000000,
        });

        await resumeUpload(
            file,
            makeState({
                fileSize: 21_000_000,
                totalParts: 3,
                completedParts: [
                    { PartNumber: 1, ETag: '"etag1"' },
                    { PartNumber: 2, ETag: '"etag2"' },
                    { PartNumber: 3, ETag: '"etag3"' },
                ],
                contentFingerprint: await computeContentFingerprint(file),
            }),
        );

        // Nothing is re-streamed on this path
        expect(FakeXHR.sentBodies.length).toBe(0);
        const completeReq = requests.find((r) => r.url.includes('/upload/complete'));
        // Pre-fix: 3 × 10,000,000 = 30,000,000 — the audit's own example number.
        expect(completeReq?.body?.actualSize).toBe(21_000_000);
    });

    it('reports the true ciphertext size for an encrypted finalize-only resume', async () => {
        // Same path, encrypted: the object is the full ECE ciphertext, which is
        // larger than file.size by the per-record tag+delimiter overhead.
        const { calculateEncryptedSize, ECE_ENCRYPTED_RECORD_SIZE, ECE_RECORD_SIZE, Keychain } =
            await import('@bolter/protocol/crypto');
        // 10 whole ECE records per part, so getEffectivePartSize() is exact
        const partSize = 10 * ECE_ENCRYPTED_RECORD_SIZE;
        const plaintextPartSize = 10 * ECE_RECORD_SIZE;
        const plaintextSize = 2 * plaintextPartSize + 1234; // 2 full parts + tail
        resumeResponse = { parts: [], partSize, numParts: 3 };
        const file = new File([new Uint8Array(plaintextSize)], 'test.bin', {
            lastModified: 1700000000000,
        });

        await resumeUpload(
            file,
            makeState({
                encrypted: true,
                secretKeyB64: new Keychain().secretKeyB64,
                fileSize: plaintextSize,
                partSize,
                plaintextPartSize,
                totalParts: 3,
                completedParts: [
                    { PartNumber: 1, ETag: '"etag1"' },
                    { PartNumber: 2, ETag: '"etag2"' },
                    { PartNumber: 3, ETag: '"etag3"' },
                ],
                contentFingerprint: await computeContentFingerprint(file),
            }),
        );

        const completeReq = requests.find((r) => r.url.includes('/upload/complete'));
        expect(completeReq?.body?.actualSize).toBe(calculateEncryptedSize(plaintextSize));
    });

    // ---------------------------------------------------------------------
    // Finding 12 — a transient 5xx must not destroy persisted resume state
    // ---------------------------------------------------------------------
    describe('resume endpoint failures', () => {
        function stubResumeStatus(status: number) {
            vi.stubGlobal(
                'fetch',
                vi.fn((url: string, init?: RequestInit) => {
                    const body = init?.body ? JSON.parse(init.body as string) : null;
                    requests.push({ url: String(url), body });
                    if (String(url).includes('/resume')) {
                        return Promise.resolve(
                            new Response(JSON.stringify({ error: 'boom' }), { status }),
                        );
                    }
                    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
                }),
            );
        }

        async function runResume(status: number) {
            stubResumeStatus(status);
            const { saveUploadState, getAnyResumableUpload } = await import('@/lib/upload-state');
            const file = new File([new Uint8Array(20_000_000)], 'test.bin', {
                lastModified: 1700000000000,
            });
            const state = makeState({
                fileId: `resume-${status}`,
                contentFingerprint: await computeContentFingerprint(file),
            });
            await saveUploadState(state);

            let message = '';
            try {
                await resumeUpload(file, state);
            } catch (e) {
                message = e instanceof Error ? e.message : String(e);
            }
            const survived = await getAnyResumableUpload();
            return { message, survived };
        }

        for (const status of [500, 502, 503, 429]) {
            it(`keeps persisted state on a transient HTTP ${status}`, async () => {
                const { message, survived } = await runResume(status);
                expect(message).toContain('temporarily unavailable');
                // Pre-fix: deleteUploadState ran for ANY non-ok status, losing
                // the completed-part list, uploadId and encryption key
                expect(survived?.fileId).toBe(`resume-${status}`);
                expect(survived?.completedParts).toHaveLength(2);
            });
        }

        for (const status of [400, 404, 410]) {
            it(`discards persisted state on a definitive HTTP ${status}`, async () => {
                const { message, survived } = await runResume(status);
                expect(message).toContain('Upload session expired');
                expect(survived).toBeNull();
            });
        }
    });

    // ---------------------------------------------------------------------
    // Finding 43 — resume identity must include file content, not just
    // (name, size, mtime): a same-tuple different file would otherwise be
    // spliced tail-onto-prefix into a corrupt but cleanly-decrypting hybrid.
    // ---------------------------------------------------------------------
    describe('file identity verification', () => {
        it('refuses to resume when the selected file content differs', async () => {
            resumeResponse = { parts: [], partSize: 10_000_000, numParts: 2 };
            const original = new File([new Uint8Array(20_000_000).fill(1)], 'test.bin', {
                lastModified: 1700000000000,
            });
            // Same name, same size, same mtime — different bytes
            const impostor = new File([new Uint8Array(20_000_000).fill(2)], 'test.bin', {
                lastModified: 1700000000000,
            });

            const state = makeState({
                contentFingerprint: await computeContentFingerprint(original),
            });

            await expect(resumeUpload(impostor, state)).rejects.toThrow(
                /does not match the interrupted upload/,
            );
            // Nothing may be sent to the server for a mismatched file
            expect(requests).toHaveLength(0);
        });

        it('refuses to resume legacy state that carries no fingerprint', async () => {
            resumeResponse = { parts: [], partSize: 10_000_000, numParts: 2 };
            const file = new File([new Uint8Array(20_000_000)], 'test.bin', {
                lastModified: 1700000000000,
            });

            await expect(
                resumeUpload(file, makeState({ contentFingerprint: undefined })),
            ).rejects.toThrow(/cannot be safely resumed/);
            expect(requests).toHaveLength(0);
        });

        it('resumes when the fingerprint matches', async () => {
            resumeResponse = { parts: [], partSize: 10_000_000, numParts: 2 };
            const file = new File([new Uint8Array(20_000_000).fill(7)], 'test.bin', {
                lastModified: 1700000000000,
            });

            const result = await resumeUpload(
                file,
                makeState({ contentFingerprint: await computeContentFingerprint(file) }),
            );
            expect(result.id).toBe('resume-file-id');
        });
    });
});
