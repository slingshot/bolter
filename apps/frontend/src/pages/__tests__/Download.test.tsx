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
vi.mock('@bolter/protocol/crypto', () => ({
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
import { trackDownload } from '@/lib/plausible';
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
    /** The hidden frame the page navigates to /download/direct/:id. */
    function downloadFrame(): HTMLIFrameElement {
        const frames = document.body.querySelectorAll('iframe');
        const frame = frames[frames.length - 1];
        if (!frame) {
            throw new Error('no download iframe was created');
        }
        return frame as HTMLIFrameElement;
    }

    /**
     * A refused /download/direct request answers with a renderable JSON error
     * body, so the frame loads a document and fires `load`. A delivered file
     * never does (Content-Disposition: attachment turns the navigation into a
     * download), which is what makes this signal attributable to this request.
     */
    function simulateRefusedRequest() {
        downloadFrame().dispatchEvent(new Event('load'));
    }

    async function clickDownload() {
        fireEvent.click(screen.getByRole('button', { name: 'Download' }));
        // Let the pre-check resolve and the frame navigation be issued
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
    }

    async function settleDirect() {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20000);
        });
    }

    async function clickDownloadAndSettleDirect() {
        await clickDownload();
        await settleDirect();
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
        expect(trackDownload).not.toHaveBeenCalled();
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
        expect(trackDownload).toHaveBeenCalled();
    });

    it('reports success for the last download of a single-download file', async () => {
        // The default share is dlimit=1, so its one and only download always
        // ends with dl === dlimit. That must still read as a plain success.
        renderDownloadPage('direct-last');
        await settle();

        vi.mocked(getDownloadStatus)
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 1 })
            .mockResolvedValue({ status: 'ok', dl: 1, dlimit: 1 });
        vi.useFakeTimers();
        await clickDownloadAndSettleDirect();

        expect(screen.getByText('Download complete!')).toBeInTheDocument();
        expect(screen.getByText(/Download limit reached/)).toBeInTheDocument();
        expect(screen.queryByText(/couldn't confirm/i)).toBeNull();
    });

    it("does not claim success when another viewer's download moved the counter", async () => {
        // The audit's scenario: dlimit=1, viewers A and B both pass the
        // pre-check at dl=0. A's request wins the credit; B's is refused with
        // 410 and delivers nothing — yet B sees the very same counter move.
        // Only B's own frame rendering the error body separates the two.
        renderDownloadPage('direct-race');
        await settle();

        vi.mocked(getDownloadStatus)
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 1 })
            .mockResolvedValue({ status: 'ok', dl: 1, dlimit: 1 });
        vi.useFakeTimers();
        await clickDownload();
        simulateRefusedRequest();
        await settleDirect();

        expect(screen.queryByText('Download complete!')).toBeNull();
        expect(screen.getByText('Download failed')).toBeInTheDocument();
        expect(screen.getByText(/download did not start/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(trackDownload).not.toHaveBeenCalled();
    });

    it('does not claim success when the redirect target rejected the request', async () => {
        // /download/direct signs and increments *before* redirecting, so an
        // expired-signature S3 error page still leaves the counter advanced.
        renderDownloadPage('direct-s3-error');
        await settle();

        vi.mocked(getDownloadStatus)
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 5 })
            .mockResolvedValue({ status: 'ok', dl: 1, dlimit: 5 });
        vi.useFakeTimers();
        await clickDownload();
        simulateRefusedRequest();
        await settleDirect();

        expect(screen.queryByText('Download complete!')).toBeNull();
        expect(screen.getByText('Download failed')).toBeInTheDocument();
    });

    it('ignores the frame resetting to about:blank', async () => {
        renderDownloadPage('direct-blank');
        await settle();

        vi.mocked(getDownloadStatus)
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 2 })
            .mockResolvedValue({ status: 'ok', dl: 1, dlimit: 2 });
        vi.useFakeTimers();
        await clickDownload();
        const frame = downloadFrame();
        Object.defineProperty(frame, 'contentWindow', {
            configurable: true,
            value: { location: { href: 'about:blank' } },
        });
        frame.dispatchEvent(new Event('load'));
        await settleDirect();

        expect(screen.getByText('Download complete!')).toBeInTheDocument();
    });

    it('does not assert completion when the status check itself failed', async () => {
        renderDownloadPage('direct3');
        await settle();

        vi.mocked(getDownloadStatus)
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 2 })
            .mockResolvedValue({ status: 'error' });
        vi.useFakeTimers();
        await clickDownloadAndSettleDirect();

        // Still not an error screen — a transient status failure is not a
        // failed download — but it is not "Download complete!" either.
        expect(screen.queryByText('Download failed')).toBeNull();
        expect(screen.queryByText('Download complete!')).toBeNull();
        expect(screen.getByText('Download started')).toBeInTheDocument();
        expect(screen.getByText(/couldn't confirm the download finished/i)).toBeInTheDocument();
    });

    it('does not assert completion when the file vanished mid-attempt', async () => {
        renderDownloadPage('direct4');
        await settle();

        vi.mocked(getDownloadStatus)
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 1 })
            .mockResolvedValue({ status: 'gone' });
        vi.useFakeTimers();
        await clickDownloadAndSettleDirect();

        expect(screen.queryByText('Download complete!')).toBeNull();
        expect(screen.getByText('Download started')).toBeInTheDocument();
        expect(screen.getByText(/couldn't confirm the download finished/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Download again' })).toBeNull();
    });

    it('holds the click guard until the verdict is reached', async () => {
        renderDownloadPage('direct5');
        await settle();

        vi.mocked(getDownloadStatus)
            // pre-check, then a re-check that still sees nothing, then the
            // server's increment — so the verdict lands after the settle
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 5 })
            .mockResolvedValueOnce({ status: 'ok', dl: 0, dlimit: 5 })
            .mockResolvedValue({ status: 'ok', dl: 1, dlimit: 5 });
        vi.useFakeTimers();
        await clickDownload();

        // Past the 3s settle but still inside the re-check window
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3500);
        });
        const pending = screen.getByRole('button', { name: /Starting download/ });
        expect(pending).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();

        // A second click must not fire another pre-check — that would navigate
        // the frame again and burn a second server-side download credit
        const callsBeforeSecondClick = vi.mocked(getDownloadStatus).mock.calls.length;
        fireEvent.click(pending);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(vi.mocked(getDownloadStatus).mock.calls.length).toBe(callsBeforeSecondClick);

        await settleDirect();
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
            evaluateDirectDownloadOutcome(
                { dl: 0, dlimit: 3 },
                { status: 'ok', dl: 1, dlimit: 3 },
                false,
            ),
        ).toBe('delivered');
    });

    it('treats an unchanged counter as a non-delivery', () => {
        expect(
            evaluateDirectDownloadOutcome(
                { dl: 0, dlimit: 3 },
                { status: 'ok', dl: 0, dlimit: 3 },
                false,
            ),
        ).toBe('not-delivered');
    });

    it('treats the last credit of a single-download file as a delivery', () => {
        // dlimit=1 is the default share, so this is the ordinary success case
        expect(
            evaluateDirectDownloadOutcome(
                { dl: 0, dlimit: 1 },
                { status: 'ok', dl: 1, dlimit: 1 },
                false,
            ),
        ).toBe('delivered');
    });

    it('rejects a request the server answered with a page, whatever the counter did', () => {
        // The audit's race: another viewer took the last credit, so the shared
        // counter advanced — but this request rendered a 410 body in the frame
        expect(
            evaluateDirectDownloadOutcome(
                { dl: 0, dlimit: 1 },
                { status: 'ok', dl: 1, dlimit: 1 },
                true,
            ),
        ).toBe('not-delivered');
        expect(evaluateDirectDownloadOutcome({ dl: 0, dlimit: 5 }, { status: 'gone' }, true)).toBe(
            'not-delivered',
        );
        expect(evaluateDirectDownloadOutcome({ dl: 0, dlimit: 5 }, { status: 'error' }, true)).toBe(
            'not-delivered',
        );
    });

    it('never reads a vanished file as evidence of delivery', () => {
        expect(evaluateDirectDownloadOutcome({ dl: 0, dlimit: 1 }, { status: 'gone' }, false)).toBe(
            'unknown',
        );
        expect(evaluateDirectDownloadOutcome({ dl: 0, dlimit: 5 }, { status: 'gone' }, false)).toBe(
            'unknown',
        );
    });

    it('cannot tell either way when the status check itself failed', () => {
        expect(
            evaluateDirectDownloadOutcome({ dl: 0, dlimit: 5 }, { status: 'error' }, false),
        ).toBe('unknown');
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

    it('does not match a status code that merely starts with 404/410', () => {
        expect(classifyDownloadError(new Error('HTTP 4041'))).toBe('other');
        expect(classifyDownloadError(new Error('read 40 of 4104 bytes'))).toBe('other');
    });
});
