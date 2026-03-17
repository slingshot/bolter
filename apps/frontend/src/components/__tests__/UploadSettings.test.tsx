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

import { useAppStore } from '@/stores/app';
import { UploadSettings } from '../UploadSettings';

describe('UploadSettings', () => {
    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        useAppStore.setState({
            encrypted: false,
            timeLimit: 86400,
            downloadLimit: 1,
            config: {
                maxFileSize: 1_000_000_000_000,
                maxFilesPerArchive: 64,
                maxExpireSeconds: 604800,
                maxDownloads: 100,
                defaultExpireSeconds: 86400,
                defaultDownloads: 1,
                expireTimes: [300, 3600, 86400, 604800],
                downloadCounts: [1, 2, 3, 4, 5, 20, 50, 100],
            },
        });
    });

    it('renders the encryption toggle', () => {
        render(<UploadSettings />);
        const toggle = screen.getByRole('switch', {
            name: 'Encrypt files for enhanced security',
        });
        expect(toggle).toBeInTheDocument();
        expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('renders time limit selector with default value', () => {
        render(<UploadSettings />);
        // The "Expires after" toggle label should be present
        expect(screen.getByText('Expires after')).toBeInTheDocument();
        // The default time limit (86400 = 1 day) should be displayed
        expect(screen.getByText('1 day')).toBeInTheDocument();
    });

    it('renders download limit selector with default value', () => {
        render(<UploadSettings />);
        // The default download limit (1) should be displayed as "1 download"
        expect(screen.getByText('1 download')).toBeInTheDocument();
    });

    it('toggling encryption updates store state', async () => {
        const user = userEvent.setup();
        render(<UploadSettings />);

        const toggle = screen.getByRole('switch', {
            name: 'Encrypt files for enhanced security',
        });
        expect(toggle).toHaveAttribute('aria-checked', 'false');

        await user.click(toggle);

        expect(useAppStore.getState().encrypted).toBe(true);
        expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('toggling encryption off after enabling', async () => {
        const user = userEvent.setup();
        useAppStore.setState({ encrypted: true });
        render(<UploadSettings />);

        const toggle = screen.getByRole('switch', {
            name: 'Encrypt files for enhanced security',
        });
        expect(toggle).toHaveAttribute('aria-checked', 'true');

        await user.click(toggle);

        expect(useAppStore.getState().encrypted).toBe(false);
        expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('clicking the encryption label text also toggles the state', async () => {
        const user = userEvent.setup();
        render(<UploadSettings />);

        const labelText = screen.getByText('Encrypt files for enhanced security');
        await user.click(labelText);

        expect(useAppStore.getState().encrypted).toBe(true);
    });

    it('renders the "or" conjunction between selectors', () => {
        render(<UploadSettings />);
        expect(screen.getByText('or')).toBeInTheDocument();
    });

    it('changing download limit updates store state', async () => {
        const user = userEvent.setup();
        render(<UploadSettings />);

        // Find the trigger displaying "1 download" and open the select
        const downloadTrigger = screen.getByText('1 download').closest('button');
        expect(downloadTrigger).toBeInTheDocument();
        await user.click(downloadTrigger as HTMLElement);

        // Select "5 downloads" from the dropdown
        const option = await screen.findByText('5 downloads');
        await user.click(option);

        expect(useAppStore.getState().downloadLimit).toBe(5);
    });

    it('changing time limit updates store state', async () => {
        const user = userEvent.setup();
        render(<UploadSettings />);

        // Find the trigger displaying "1 day" and open the select
        const timeTrigger = screen.getByText('1 day').closest('button');
        expect(timeTrigger).toBeInTheDocument();
        await user.click(timeTrigger as HTMLElement);

        // Select "1 hour" from the dropdown
        const option = await screen.findByText('1 hour');
        await user.click(option);

        expect(useAppStore.getState().timeLimit).toBe(3600);
    });
});
