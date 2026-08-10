import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: finding #15 — the server sets the metadata TTL when `/upload/url`
 * mints the file id and never refreshes it at `/upload/complete`. A resume can
 * complete days later, so computing the expiry from the completion time makes
 * "Recent uploads" advertise a file as live long after Redis dropped it.
 *
 * This drives the real component with the completion result `api.ts` actually
 * produces — a four-field `UploadResult` carrying no `expiresAt`/`ttl` — so the
 * test fails if `handleResumeFileSelected` ever goes back to anchoring on
 * `Date.now()`.
 */

const resumeUpload = vi.fn();

vi.mock('@/lib/api', () => {
    class Canceller {
        cancelled = false;
        cancel() {
            this.cancelled = true;
        }
    }
    class FileReadError extends Error {}
    return {
        Canceller,
        FileReadError,
        resumeUpload: (...args: unknown[]) => resumeUpload(...args),
        uploadFiles: vi.fn(),
        deleteFile: vi.fn().mockResolvedValue(true),
        getDownloadStatus: vi.fn().mockResolvedValue({ status: 'error' }),
        getFileInfo: vi.fn().mockResolvedValue({ status: 'error' }),
        API_BASE_URL: 'http://localhost:3001',
    };
});

vi.mock('@/lib/crypto', () => ({
    // Accepts an optional secretKeyB64 (the encrypted-resume path) and ignores it.
    Keychain: class {
        secretKeyB64 = 'secret-key-b64';
    },
}));

vi.mock('@/lib/upload-state', () => ({
    cleanupExpiredUploads: vi.fn().mockResolvedValue(undefined),
    discardResumableUpload: vi.fn().mockResolvedValue(undefined),
    getAnyResumableUpload: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/plausible', () => ({
    trackUpload: vi.fn(),
    trackDownload: vi.fn(),
}));

vi.mock('@/lib/sentry', () => ({
    captureError: vi.fn(),
    addBreadcrumb: vi.fn(),
}));

import type { PersistedUpload } from '@/lib/upload-state';
import { HomePage } from '@/pages/Home';
import { useAppStore } from '@/stores/app';

const DAY = 24 * 60 * 60 * 1000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

function makeResumable(overrides: Partial<PersistedUpload> = {}): PersistedUpload {
    return {
        fileId: 'file-1',
        uploadId: 'mp-1',
        ownerToken: 'owner-token',
        fileName: 'big.bin',
        fileSize: 11,
        fileLastModified: 1_700_000_000_000,
        encrypted: false,
        partSize: 10_000_000,
        plaintextPartSize: 10_000_000,
        completedParts: [{ PartNumber: 1, ETag: 'e1' }],
        totalParts: 2,
        timeLimit: WEEK_SECONDS,
        downloadLimit: 1,
        createdAt: Date.now() - 3 * DAY, // upload started three days ago
        ...overrides,
    };
}

describe('HomePage — resumed upload expiry', () => {
    beforeEach(() => {
        resumeUpload.mockReset();
        localStorage.clear();
        useAppStore.setState({
            files: [],
            uploadedFiles: [],
            toasts: [],
            isUploading: false,
            resumableUpload: null,
            config: null,
        });
    });

    afterEach(() => {
        cleanup();
    });

    it('anchors the recorded expiry to when the upload started, not when it completed', async () => {
        const resumable = makeResumable();
        useAppStore.setState({ resumableUpload: resumable });

        // Exactly what api.ts returns today: it discards the /upload/complete
        // body and builds this four-field literal.
        resumeUpload.mockResolvedValue({
            id: 'file-1',
            url: 'https://example.com/download/file-1',
            ownerToken: 'owner-token',
            duration: 1234,
        });

        const { container } = render(<HomePage />);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        expect(input).toBeTruthy();

        const file = new File(['hello world'], 'big.bin');
        Object.defineProperty(file, 'lastModified', { value: resumable.fileLastModified });
        fireEvent.change(input, { target: { files: [file] } });

        await waitFor(() => {
            expect(useAppStore.getState().uploadedFiles).toHaveLength(1);
        });

        const recorded = useAppStore.getState().uploadedFiles[0];
        const expected = resumable.createdAt + WEEK_SECONDS * 1000;
        expect(recorded.expiresAt.getTime()).toBe(expected);

        // The pre-fix computation (`Date.now() + timeLimit`) would have landed
        // three days later — the audit's "sender shares the link on day 8"
        // scenario. Assert we are nowhere near it.
        expect(recorded.expiresAt.getTime()).toBeLessThan(Date.now() + WEEK_SECONDS * 1000 - DAY);
    });
});
