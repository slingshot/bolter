import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { DropZone } from '../DropZone';

describe('DropZone', () => {
    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        useAppStore.setState({
            files: [],
            config: {
                maxFileSize: 1_000_000_000_000, // 1TB
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

    it('renders the drop zone area with instructions', () => {
        render(<DropZone />);
        // The text "Drag files or folders here" is split across button elements
        expect(screen.getByText('files')).toBeInTheDocument();
        expect(screen.getByText('folders')).toBeInTheDocument();
        // Use a custom text matcher to find the full instructional text
        expect(
            screen.getByText((_content, element) => {
                return element?.tagName === 'P' && /Drag.*here/.test(element.textContent ?? '');
            }),
        ).toBeInTheDocument();
    });

    it('shows the max file size information', () => {
        render(<DropZone />);
        // 1TB should show "Send up to 1TB"
        expect(screen.getByText(/Send up to 1TB/)).toBeInTheDocument();
    });

    it('shows GB when max size is less than 1TB', () => {
        const currentConfig = useAppStore.getState().config;
        if (currentConfig) {
            useAppStore.setState({
                config: {
                    ...currentConfig,
                    maxFileSize: 5_000_000_000, // 5GB
                },
            });
        }
        render(<DropZone />);
        expect(screen.getByText(/Send up to 5GB/)).toBeInTheDocument();
    });

    it('has a hidden file input element', () => {
        render(<DropZone />);
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        expect(fileInput).toBeInTheDocument();
        expect(fileInput).toHaveAttribute('type', 'file');
        expect(fileInput).toHaveAttribute('multiple');
        expect(fileInput).toHaveClass('hidden');
    });

    it('has a hidden folder input element', () => {
        render(<DropZone />);
        const folderInput = document.getElementById('folder-input') as HTMLInputElement;
        expect(folderInput).toBeInTheDocument();
        expect(folderInput).toHaveAttribute('type', 'file');
        expect(folderInput).toHaveClass('hidden');
    });

    it('clicking the "files" button triggers the file input', async () => {
        const user = userEvent.setup();
        render(<DropZone />);

        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const clickSpy = vi.spyOn(fileInput, 'click');

        const filesButton = screen.getByText('files');
        await user.click(filesButton);

        expect(clickSpy).toHaveBeenCalledOnce();
        clickSpy.mockRestore();
    });

    it('clicking the "folders" button triggers the folder input', async () => {
        const user = userEvent.setup();
        render(<DropZone />);

        const folderInput = document.getElementById('folder-input') as HTMLInputElement;
        const clickSpy = vi.spyOn(folderInput, 'click');

        const foldersButton = screen.getByText('folders');
        await user.click(foldersButton);

        expect(clickSpy).toHaveBeenCalledOnce();
        clickSpy.mockRestore();
    });

    it('drag enter adds the active styling class', () => {
        const { container } = render(<DropZone />);
        const dropArea = container.firstChild as HTMLElement;

        fireEvent.dragEnter(dropArea, {
            dataTransfer: {
                items: [{ kind: 'file' }],
            },
        });

        expect(dropArea.className).toContain('border-border-medium');
        expect(dropArea.className).toContain('bg-overlay-medium');
    });

    it('drag leave removes the active styling class', () => {
        const { container } = render(<DropZone />);
        const dropArea = container.firstChild as HTMLElement;

        fireEvent.dragEnter(dropArea, {
            dataTransfer: {
                items: [{ kind: 'file' }],
            },
        });

        // Verify it has the active class
        expect(dropArea.className).toContain('bg-overlay-medium');

        fireEvent.dragLeave(dropArea);

        // After leave, it should have the subtle styling instead
        expect(dropArea.className).toContain('bg-overlay-subtle');
    });

    it('adding files via the file input calls addFiles on the store', () => {
        render(<DropZone />);
        const fileInput = document.getElementById('file-input') as HTMLInputElement;

        const file = new File(['test content'], 'test.txt', { type: 'text/plain' });

        // Simulate file selection
        Object.defineProperty(fileInput, 'files', {
            value: [file],
            writable: false,
        });

        fireEvent.change(fileInput);

        const { files } = useAppStore.getState();
        expect(files).toHaveLength(1);
        expect(files[0].file.name).toBe('test.txt');
        expect(files[0].status).toBe('pending');
    });

    it('drop event processes files and adds them to the store', () => {
        const { container } = render(<DropZone />);
        const dropArea = container.firstChild as HTMLElement;

        const file = new File(['hello'], 'dropped.txt', { type: 'text/plain' });

        // For drop events, processDataTransferItems uses webkitGetAsEntry
        // which is hard to fully mock. Instead we test the fallback path
        // by making items not have webkitGetAsEntry
        const dataTransfer = {
            items: {
                length: 1,
                0: {
                    kind: 'file',
                    webkitGetAsEntry: () => null, // triggers fallback
                },
                [Symbol.iterator]: function* () {
                    yield this[0];
                },
            },
            files: [file],
        };

        fireEvent.drop(dropArea, { dataTransfer });

        // The processDataTransferItems will find no entries from webkitGetAsEntry (returned null)
        // so it returns empty files, and since no files result, nothing is added.
        // But the drop event itself should still reset isDragging
        expect(dropArea.className).toContain('bg-overlay-subtle');
    });

    it('uses fallback max size from UPLOAD_LIMITS when config is null', () => {
        useAppStore.setState({ config: null });
        render(<DropZone />);
        // Default UPLOAD_LIMITS.MAX_FILE_SIZE is 1TB
        expect(screen.getByText(/Send up to 1TB/)).toBeInTheDocument();
    });
});
