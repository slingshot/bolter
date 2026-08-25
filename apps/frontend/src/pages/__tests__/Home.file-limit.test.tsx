import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: `MAX_FILES_PER_ARCHIVE` is advertised by `GET /config` and
 * enforced by `POST /upload/complete`, but nothing between the two ever
 * checked it. A 105-file selection therefore transferred every byte before
 * the server refused the completion, and the user's error was the raw
 * `HTTP 400: {"error":"Too many files: …"}` body (Sentry BOLTER-FRONTEND-5F).
 *
 * The gate reads the server-advertised limit rather than the shared constant,
 * so raising `MAX_FILES_PER_ARCHIVE` server-side keeps client and server in
 * step with no frontend release.
 */

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
        resumeUpload: vi.fn(),
        resumeEngineUpload: vi.fn(),
        uploadFiles: vi.fn(),
        deleteFile: vi.fn().mockResolvedValue(true),
        getDownloadStatus: vi.fn().mockResolvedValue({ status: 'error' }),
        getFileInfo: vi.fn().mockResolvedValue({ status: 'error' }),
        API_BASE_URL: 'http://localhost:3001',
    };
});

vi.mock('@bolter/protocol/crypto', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@bolter/protocol/crypto')>()),
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

import { HomePage } from '@/pages/Home';
import { useAppStore } from '@/stores/app';

const CONFIG = {
    maxFileSize: 1_000_000_000,
    maxFilesPerArchive: 3,
    maxExpireSeconds: 604_800,
    maxDownloads: 100,
    defaultExpireSeconds: 86_400,
    defaultDownloads: 1,
    expireTimes: [86_400],
    downloadCounts: [1],
};

function selectFiles(count: number): void {
    useAppStore.setState({
        files: Array.from({ length: count }, (_, i) => ({
            id: `f${i}`,
            file: new File(['x'], `photo-${i}.jpg`),
            status: 'pending' as const,
            progress: 0,
        })),
    });
}

function uploadButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /^Upload$/ }) as HTMLButtonElement;
}

describe('HomePage — MAX_FILES_PER_ARCHIVE', () => {
    beforeEach(() => {
        localStorage.clear();
        useAppStore.setState({
            files: [],
            uploadedFiles: [],
            toasts: [],
            isUploading: false,
            resumableUpload: null,
            config: CONFIG,
        });
    });

    afterEach(() => {
        cleanup();
    });

    it('refuses to start an upload that exceeds the advertised file limit', () => {
        selectFiles(4);

        render(<HomePage />);

        expect(uploadButton()).toBeDisabled();
        // Names both numbers: the limit alone leaves the user counting.
        expect(screen.getByText('Too many files: 4 selected, limit is 3')).toBeTruthy();
    });

    it('allows a selection sitting exactly on the limit', () => {
        selectFiles(3);

        render(<HomePage />);

        expect(uploadButton()).not.toBeDisabled();
        expect(screen.queryByText(/Too many files/i)).toBeNull();
    });
});
