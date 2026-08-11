import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: spec resume-tree branches 3 (handleless single-file fallback)
 * and 4 (multi-file "Start fresh only") were never surfaced — Home filtered
 * engine resume candidates down to 'finish' and handle-backed
 * 'need-source-single', so a crashed multi-file (or handleless single-file)
 * engine upload rendered nothing at all. With no reachable discard, the
 * lease shielded the staged OPFS ciphertext from GC forever and the
 * server-side multipart was never aborted client-side.
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
        resumeEngineUploadWithFile: vi.fn(),
        computeContentFingerprint: vi.fn(),
        uploadFiles: vi.fn(),
        deleteFile: vi.fn().mockResolvedValue(true),
        getDownloadStatus: vi.fn().mockResolvedValue({ status: 'error' }),
        getFileInfo: vi.fn().mockResolvedValue({ status: 'error' }),
        API_BASE_URL: 'http://localhost:3001',
    };
});

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

const engineStartupMaintenance = vi.fn();
const discardEngineUpload = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/upload-engine/client', () => ({
    engineStartupMaintenance: (...args: unknown[]) => engineStartupMaintenance(...args),
    discardEngineUpload: (...args: unknown[]) => discardEngineUpload(...args),
    currentUploadAttempt: vi.fn().mockReturnValue(undefined),
    resetUploadAttemptTelemetry: vi.fn(),
}));

import type { EngineResumeCandidate } from '@/lib/upload-engine/client';
import { HomePage } from '@/pages/Home';
import { useAppStore } from '@/stores/app';

function makeCandidate(over: Partial<EngineResumeCandidate>): EngineResumeCandidate {
    return {
        fileId: 'up_leaked1',
        fileName: '3 files',
        size: 512 * 1024 * 1024,
        encrypted: true,
        secretKeyB64: 'secret-b64',
        timeLimit: 86_400,
        downloadLimit: 1,
        createdAt: Date.now() - 60_000,
        action: 'need-source-multi',
        ...over,
    };
}

describe('HomePage — un-resumable engine uploads still get Start fresh', () => {
    beforeEach(() => {
        engineStartupMaintenance.mockReset();
        discardEngineUpload.mockReset().mockResolvedValue(undefined);
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

    it('surfaces a need-source-multi candidate with Start fresh only', async () => {
        engineStartupMaintenance.mockResolvedValue([makeCandidate({})]);

        const { getByText, queryByText } = render(<HomePage />);
        await waitFor(() => {
            expect(getByText('Interrupted upload cannot be resumed')).toBeTruthy();
        });

        // No resume affordance — only the discard.
        expect(queryByText('Finish upload')).toBeNull();
        expect(queryByText('Resume upload')).toBeNull();
        fireEvent.click(getByText('Start fresh'));

        await waitFor(() => {
            expect(discardEngineUpload).toHaveBeenCalledWith('up_leaked1');
        });
        // The card is gone once discarded.
        expect(queryByText('Interrupted upload cannot be resumed')).toBeNull();
    });

    it('surfaces a handleless need-source-single candidate with Start fresh only', async () => {
        engineStartupMaintenance.mockResolvedValue([
            makeCandidate({
                fileId: 'up_leaked2',
                fileName: 'video.mov',
                action: 'need-source-single', // no handle — non-Chromium pick
            }),
        ]);

        const { getByText, queryByText } = render(<HomePage />);
        await waitFor(() => {
            expect(getByText('Interrupted upload cannot be resumed')).toBeTruthy();
        });

        expect(queryByText('Resume upload')).toBeNull();
        fireEvent.click(getByText('Start fresh'));
        await waitFor(() => {
            expect(discardEngineUpload).toHaveBeenCalledWith('up_leaked2');
        });
    });

    it('still prefers a finish candidate over an un-resumable one', async () => {
        engineStartupMaintenance.mockResolvedValue([
            makeCandidate({}),
            makeCandidate({ fileId: 'up_finish', fileName: 'a.bin', action: 'finish' }),
        ]);

        const { getByText } = render(<HomePage />);
        await waitFor(() => {
            expect(getByText('Finish upload — no file selection needed')).toBeTruthy();
        });
    });
});
