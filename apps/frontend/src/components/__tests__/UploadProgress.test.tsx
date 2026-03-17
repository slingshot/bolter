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
import { UploadProgress } from '../UploadProgress';

describe('UploadProgress', () => {
    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        useAppStore.setState({
            isUploading: false,
            uploadProgress: null,
            zippingProgress: null,
            checkingSpeed: false,
            currentCanceller: null,
        });
    });

    it('renders nothing when not uploading', () => {
        const { container } = render(<UploadProgress />);
        expect(container.innerHTML).toBe('');
    });

    it('shows "Preparing upload..." when uploading with no progress yet', () => {
        useAppStore.setState({ isUploading: true });
        render(<UploadProgress />);
        expect(screen.getByText('Preparing upload...')).toBeInTheDocument();
    });

    it('shows progress percentage when uploading', () => {
        useAppStore.setState({
            isUploading: true,
            uploadProgress: {
                loaded: 500_000,
                total: 1_000_000,
                percentage: 50,
                speed: 100_000,
                remainingTime: 5,
                retryCount: 0,
                isOffline: false,
                connectionQuality: 'good' as const,
            },
        });
        render(<UploadProgress />);
        expect(screen.getByText('Uploading...')).toBeInTheDocument();
        expect(screen.getByText('50%')).toBeInTheDocument();
    });

    it('shows speed information during upload', () => {
        useAppStore.setState({
            isUploading: true,
            uploadProgress: {
                loaded: 250_000,
                total: 1_000_000,
                percentage: 25,
                speed: 500_000,
                remainingTime: 3,
                retryCount: 0,
                isOffline: false,
                connectionQuality: 'good' as const,
            },
        });
        render(<UploadProgress />);
        // formatSpeed(500_000) = "500 KB/s"
        expect(screen.getByText('500 KB/s')).toBeInTheDocument();
        // formatDuration(3) = "3s"
        expect(screen.getByText('3s remaining')).toBeInTheDocument();
    });

    it('shows byte progress during upload', () => {
        useAppStore.setState({
            isUploading: true,
            uploadProgress: {
                loaded: 500_000_000,
                total: 1_000_000_000,
                percentage: 50,
                speed: 10_000_000,
                remainingTime: 50,
                retryCount: 0,
                isOffline: false,
                connectionQuality: 'good' as const,
            },
        });
        render(<UploadProgress />);
        // formatBytes(500_000_000) = "500 MB", formatBytes(1_000_000_000) = "1 GB"
        expect(screen.getByText('500 MB / 1 GB')).toBeInTheDocument();
    });

    it('shows retry status when retries > 0 and connection is not good', () => {
        useAppStore.setState({
            isUploading: true,
            uploadProgress: {
                loaded: 100_000,
                total: 1_000_000,
                percentage: 10,
                speed: 50_000,
                remainingTime: 18,
                retryCount: 3,
                isOffline: false,
                connectionQuality: 'slow' as const,
            },
        });
        render(<UploadProgress />);
        expect(screen.getByText('Retrying... (3 retries)')).toBeInTheDocument();
    });

    it('shows singular "retry" when retryCount is 1', () => {
        useAppStore.setState({
            isUploading: true,
            uploadProgress: {
                loaded: 100_000,
                total: 1_000_000,
                percentage: 10,
                speed: 50_000,
                remainingTime: 18,
                retryCount: 1,
                isOffline: false,
                connectionQuality: 'fair' as const,
            },
        });
        render(<UploadProgress />);
        expect(screen.getByText('Retrying... (1 retry)')).toBeInTheDocument();
    });

    it('shows "Checking speed..." when checkingSpeed is true', () => {
        useAppStore.setState({
            isUploading: true,
            checkingSpeed: true,
        });
        render(<UploadProgress />);
        expect(screen.getByText('Checking speed...')).toBeInTheDocument();
    });

    it('shows zipping progress when zippingProgress is set and upload has not started', () => {
        useAppStore.setState({
            isUploading: true,
            zippingProgress: 45,
            uploadProgress: null,
        });
        render(<UploadProgress />);
        expect(screen.getByText('Compressing files...')).toBeInTheDocument();
        expect(screen.getByText('45% compressed')).toBeInTheDocument();
    });

    it('shows "Waiting for connection..." when offline', () => {
        useAppStore.setState({
            isUploading: true,
            uploadProgress: {
                loaded: 100_000,
                total: 1_000_000,
                percentage: 10,
                speed: 0,
                remainingTime: 0,
                retryCount: 0,
                isOffline: true,
                connectionQuality: 'offline' as const,
            },
        });
        render(<UploadProgress />);
        expect(screen.getByText('Waiting for connection...')).toBeInTheDocument();
    });

    it('shows "Connection stalled..." when quality is stalled', () => {
        useAppStore.setState({
            isUploading: true,
            uploadProgress: {
                loaded: 100_000,
                total: 1_000_000,
                percentage: 10,
                speed: 0,
                remainingTime: 0,
                retryCount: 0,
                isOffline: false,
                connectionQuality: 'stalled' as const,
            },
        });
        render(<UploadProgress />);
        expect(screen.getByText('Connection stalled...')).toBeInTheDocument();
    });

    it('has a cancel button that invokes the canceller', async () => {
        const user = userEvent.setup();
        const cancelFn = vi.fn();
        useAppStore.setState({
            isUploading: true,
            currentCanceller: { cancel: cancelFn, cancelled: false, xhrs: [] } as never,
        });
        render(<UploadProgress />);

        const cancelButton = screen.getByRole('button', { name: /cancel/i });
        expect(cancelButton).toBeInTheDocument();
        await user.click(cancelButton);
        expect(cancelFn).toHaveBeenCalledOnce();
    });

    it('does not show remaining time when remainingTime is 0', () => {
        useAppStore.setState({
            isUploading: true,
            uploadProgress: {
                loaded: 500_000,
                total: 1_000_000,
                percentage: 50,
                speed: 100_000,
                remainingTime: 0,
                retryCount: 0,
                isOffline: false,
                connectionQuality: 'good' as const,
            },
        });
        render(<UploadProgress />);
        expect(screen.queryByText(/remaining/)).not.toBeInTheDocument();
    });
});
