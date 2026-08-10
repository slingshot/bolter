import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    API_BASE_URL: 'http://localhost:3001',
    checkLegacyFile: vi.fn(),
    downloadFile: vi.fn(),
    fileExists: vi.fn(),
    getDownloadStatus: vi.fn(),
    getMetadata: vi.fn(),
}));
vi.mock('@/lib/sentry', () => ({
    captureError: vi.fn(),
    addBreadcrumb: vi.fn(),
}));
vi.mock('@/lib/plausible', () => ({
    trackDownload: vi.fn(),
}));
vi.mock('@/lib/crypto', () => ({
    Keychain: class {
        secret: string;
        constructor(secret: string) {
            this.secret = secret;
        }
    },
}));
vi.mock('@/lib/utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/utils')>()),
    triggerDownload: vi.fn(),
}));

import {
    checkLegacyFile,
    downloadFile,
    fileExists,
    getDownloadStatus,
    getMetadata,
} from '@/lib/api';
import { captureError } from '@/lib/sentry';
import {
    classifyDownloadError,
    DownloadPage,
    evaluateDirectDownloadOutcome,
} from '@/pages/Download';

const plainMetadata = {
    name: 'report.pdf',
    size: 1024,
    type: 'application/pdf',
    ttl: 3600,
    encrypted: false,
};

const encryptedMetadata = { ...plainMetadata, encrypted: true };

function renderDownloadPage(id: string, hash = '') {
    // The component reads window.location directly (that is the URL telemetry
    // sees); MemoryRouter only supplies the :id param.
    window.history.replaceState(null, '', `/download/${id}${hash}`);
    return render(
        <MemoryRouter initialEntries={[`/download/${id}`]}>
            <Routes>
                <Route path="/download/:id" element={<DownloadPage />} />
            </Routes>
        </MemoryRouter>,
    );
}

/** Flush the metadata-loading promise chain. */
async function settle() {
    for (let i = 0; i < 6; i++) {
        await act(async () => {
            await Promise.resolve();
        });
    }
}

beforeEach(() => {
    vi.mocked(fileExists).mockResolvedValue(true);
    vi.mocked(checkLegacyFile).mockResolvedValue(null);
    vi.mocked(getDownloadStatus).mockResolvedValue({ status: 'ok', dl: 0, dlimit: 1 });
    vi.mocked(getMetadata).mockResolvedValue(plainMetadata);
    vi.mocked(downloadFile).mockResolvedValue({
        blob: new Blob(['x']),
        filename: 'report.pdf',
    } as Awaited<ReturnType<typeof downloadFile>>);
    vi.mocked(captureError).mockClear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('#1 — the decryption key never survives in the address bar', () => {
    it('strips the fragment during render, before anything reads location.href', () => {
        vi.mocked(getMetadata).mockResolvedValue(encryptedMetadata);
        let urlAtFirstRequest = '';
        vi.mocked(fileExists).mockImplementation(() => {
            urlAtFirstRequest = window.location.href;
            return Promise.resolve(true);
        });

        renderDownloadPage('leak1', '#s3cr3tk3y');

        // Synchronous: the strip happens in render, ahead of every effect,
        // breadcrumb and network call — and ahead of any telemetry read.
        expect(window.location.hash).toBe('');
        expect(window.location.href).not.toContain('s3cr3tk3y');
        expect(urlAtFirstRequest).not.toContain('s3cr3tk3y');
    });

    it('still decrypts with the captured key after stripping it', async () => {
        vi.mocked(getMetadata).mockResolvedValue(encryptedMetadata);

        renderDownloadPage('leak2', '#capturedkey');
        await settle();

        expect(getMetadata).toHaveBeenCalled();
        const keychain = vi.mocked(getMetadata).mock.calls[0][1] as unknown as { secret: string };
        expect(keychain.secret).toBe('capturedkey');
        expect(window.location.href).not.toContain('capturedkey');
    });

    it('tells the user to reopen the original link when the key is gone', async () => {
        const missingKey = new Error('This file is encrypted, but the link is missing its key.');
        missingKey.name = 'MissingKeyError';
        vi.mocked(getMetadata).mockRejectedValue(missingKey);

        renderDownloadPage('leak3');
        await settle();

        expect(screen.getByText(/Open the original share link again/)).toBeInTheDocument();
        // Retrying a reload that dropped the key cannot help
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });
});

describe('#14 — direct download only reports success when bytes were delivered', () => {
    async function clickDownloadAndSettleDirect() {
        fireEvent.click(screen.getByRole('button', { name: 'Download' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20000);
        });
    }

    it('shows an error when the download counter never moved', async () => {
        renderDownloadPage('direct1');
        await settle();
        expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();

        // Every post-navigation check still reports dl=0: the iframe request
        // was refused (410 at the limit, or a 500) and delivered nothing.
        vi.useFakeTimers();
        await clickDownloadAndSettleDirect();

        expect(screen.queryByText('Download complete!')).toBeNull();
        expect(screen.getByText('Download failed')).toBeInTheDocument();
        expect(screen.getByText(/download did not start/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('reports success once the counter has advanced', async () => {
        renderDownloadPage('direct2');
        await settle();

        // Pre-check sees dl=0, the post-navigation checks see the server's
        // increment: bytes really were delivered.
        vi.mocked(getDownloadStatus)
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 2 })
            .mockResolvedValue({ status: 'ok', dl: 1, dlimit: 2 });
        vi.useFakeTimers();
        await clickDownloadAndSettleDirect();

        expect(screen.getByText('Download complete!')).toBeInTheDocument();
    });

    it('does not turn a transient status error into a failure', async () => {
        renderDownloadPage('direct3');
        await settle();

        vi.mocked(getDownloadStatus)
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 2 })
            .mockResolvedValue({ status: 'error' });
        vi.useFakeTimers();
        await clickDownloadAndSettleDirect();

        expect(screen.getByText('Download complete!')).toBeInTheDocument();
    });
});

describe('#32 — an exhausted or deleted file is not a retryable error', () => {
    it('shows the not-found screen for HTTP 410 instead of a generic failure', async () => {
        vi.mocked(getMetadata).mockResolvedValue(encryptedMetadata);
        vi.mocked(downloadFile).mockRejectedValue(new Error('HTTP 410'));

        renderDownloadPage('limit1', '#somekey');
        await settle();

        fireEvent.click(screen.getByRole('button', { name: 'Download' }));
        await settle();

        expect(screen.getByText('File not found')).toBeInTheDocument();
        expect(screen.queryByText('Download failed')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
        expect(captureError).not.toHaveBeenCalled();
    });

    it('shows the not-found screen for HTTP 404 after the file was deleted', async () => {
        vi.mocked(getMetadata).mockResolvedValue(encryptedMetadata);
        vi.mocked(downloadFile).mockRejectedValue(new Error('HTTP 404'));

        renderDownloadPage('limit2', '#somekey');
        await settle();

        fireEvent.click(screen.getByRole('button', { name: 'Download' }));
        await settle();

        expect(screen.getByText('File not found')).toBeInTheDocument();
        expect(captureError).not.toHaveBeenCalled();
    });

    it('still reports genuine failures as errors', async () => {
        vi.mocked(getMetadata).mockResolvedValue(encryptedMetadata);
        vi.mocked(downloadFile).mockRejectedValue(new Error('HTTP 500'));

        renderDownloadPage('limit3', '#somekey');
        await settle();

        fireEvent.click(screen.getByRole('button', { name: 'Download' }));
        await settle();

        expect(screen.getByText('Download failed')).toBeInTheDocument();
        expect(captureError).toHaveBeenCalled();
    });
});

describe('evaluateDirectDownloadOutcome', () => {
    it('treats an advanced counter as a delivery', () => {
        expect(
            evaluateDirectDownloadOutcome({ dl: 0, dlimit: 3 }, { status: 'ok', dl: 1, dlimit: 3 }),
        ).toBe('delivered');
    });

    it('treats an unchanged counter as a non-delivery', () => {
        expect(
            evaluateDirectDownloadOutcome({ dl: 0, dlimit: 3 }, { status: 'ok', dl: 0, dlimit: 3 }),
        ).toBe('not-delivered');
    });

    it('accepts a vanished file when this download would have exhausted the limit', () => {
        expect(evaluateDirectDownloadOutcome({ dl: 0, dlimit: 1 }, { status: 'gone' })).toBe(
            'delivered',
        );
    });

    it('rejects a vanished file that still had downloads left', () => {
        expect(evaluateDirectDownloadOutcome({ dl: 0, dlimit: 5 }, { status: 'gone' })).toBe(
            'not-delivered',
        );
    });

    it('cannot tell either way when the status check itself failed', () => {
        expect(evaluateDirectDownloadOutcome({ dl: 0, dlimit: 5 }, { status: 'error' })).toBe(
            'unknown',
        );
    });
});

describe('classifyDownloadError', () => {
    it('classifies the typed limit error', () => {
        const err = new Error('Download limit reached');
        err.name = 'LimitReachedError';
        expect(classifyDownloadError(err)).toBe('limit');
    });

    it('classifies raw 404/410 responses as limit conditions', () => {
        expect(classifyDownloadError(new Error('HTTP 410'))).toBe('limit');
        expect(classifyDownloadError(new Error('HTTP 404'))).toBe('limit');
    });

    it('classifies key problems separately', () => {
        const missing = new Error('missing key');
        missing.name = 'MissingKeyError';
        const invalid = new Error('bad key');
        invalid.name = 'InvalidKeyError';
        expect(classifyDownloadError(missing)).toBe('key');
        expect(classifyDownloadError(invalid)).toBe('key');
    });

    it('leaves real failures alone', () => {
        expect(classifyDownloadError(new Error('HTTP 500'))).toBe('other');
        expect(classifyDownloadError(new Error('Network request failed'))).toBe('other');
        expect(classifyDownloadError('boom')).toBe('other');
    });
});
