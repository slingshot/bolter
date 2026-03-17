import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    deleteFile: vi.fn().mockResolvedValue(undefined),
    API_BASE_URL: 'http://localhost:3001',
}));
vi.mock('@/lib/sentry', () => ({
    captureError: vi.fn(),
    addBreadcrumb: vi.fn(),
}));

import type { UploadedFile } from '@/stores/app';
import { ShareDialog } from '../ShareDialog';

const makeFile = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
    id: 'test-file-id',
    url: 'https://example.com/download/abc',
    secretKey: 'my-secret-key-b64',
    ownerToken: 'owner-token',
    name: 'photo.jpg',
    size: 2_500_000,
    expiresAt: new Date('2026-04-01T00:00:00Z'),
    downloadLimit: 5,
    downloadCount: 0,
    ...overrides,
});

describe('ShareDialog', () => {
    const onClose = vi.fn();

    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        onClose.mockClear();
    });

    it('renders the full download URL with secret key in the input', () => {
        const file = makeFile();
        render(<ShareDialog file={file} onClose={onClose} />);

        const input = screen.getByDisplayValue(
            'https://example.com/download/abc#my-secret-key-b64',
        );
        expect(input).toBeInTheDocument();
        expect(input).toHaveAttribute('readOnly');
    });

    it('displays the file name in the description', () => {
        const file = makeFile({ name: 'important-document.pdf' });
        render(<ShareDialog file={file} onClose={onClose} />);

        expect(screen.getByText('important-document.pdf')).toBeInTheDocument();
    });

    it('shows the dialog title', () => {
        render(<ShareDialog file={makeFile()} onClose={onClose} />);

        expect(screen.getByText('Your file is encrypted and ready to send')).toBeInTheDocument();
    });

    it('has a copy link button', () => {
        render(<ShareDialog file={makeFile()} onClose={onClose} />);

        const copyButton = screen.getByRole('button', { name: /copy link/i });
        expect(copyButton).toBeInTheDocument();
    });

    it('copy button changes text to "Copied!" on click', async () => {
        const user = userEvent.setup();

        // Mock clipboard API using defineProperty since navigator.clipboard has only a getter
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            writable: true,
            configurable: true,
        });

        const file = makeFile();
        render(<ShareDialog file={file} onClose={onClose} />);

        const copyButton = screen.getByRole('button', { name: /copy link/i });
        await user.click(copyButton);

        expect(writeText).toHaveBeenCalledWith(
            'https://example.com/download/abc#my-secret-key-b64',
        );
        expect(await screen.findByText('Copied!')).toBeInTheDocument();
    });

    it('renders a QR code SVG', () => {
        const { container } = render(<ShareDialog file={makeFile()} onClose={onClose} />);

        // qrcode.react renders an SVG element
        const svg = container.querySelector('svg');
        expect(svg).toBeInTheDocument();
    });

    it('has a close button that calls onClose', async () => {
        const user = userEvent.setup();
        render(<ShareDialog file={makeFile()} onClose={onClose} />);

        const closeButton = screen.getByRole('button', { name: /^close$/i });
        await user.click(closeButton);

        expect(onClose).toHaveBeenCalledOnce();
    });

    it('clicking the backdrop calls onClose', async () => {
        const user = userEvent.setup();
        render(<ShareDialog file={makeFile()} onClose={onClose} />);

        // The outermost div is the backdrop; clicking it should fire onClose
        // We need to click the backdrop area, not the dialog card inside it
        const backdrop = screen
            .getByText('Your file is encrypted and ready to send')
            .closest('.fixed');
        expect(backdrop).toBeInTheDocument();
        // Click directly on the backdrop element (not a child)
        await user.click(backdrop as HTMLElement);

        expect(onClose).toHaveBeenCalled();
    });

    it('clicking inside the dialog card does not call onClose', async () => {
        const user = userEvent.setup();
        render(<ShareDialog file={makeFile()} onClose={onClose} />);

        const title = screen.getByText('Your file is encrypted and ready to send');
        await user.click(title);

        // onClose should NOT have been called from clicking inside the card
        // (only from close button or backdrop)
        // The card has stopPropagation, so clicking the title should not trigger backdrop onClose
        expect(onClose).not.toHaveBeenCalled();
    });
});
