import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the store
vi.mock('@/lib/api', () => ({
    deleteFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/sentry', () => ({
    captureError: vi.fn(),
    addBreadcrumb: vi.fn(),
}));

import { deleteFile } from '@/lib/api';
import { type UploadedFile, useAppStore } from '@/stores/app';

function makeUploadedFile(overrides: Partial<UploadedFile> = {}): UploadedFile {
    return {
        id: `file-${Math.random().toString(36).slice(2)}`,
        url: 'https://example.com/download/abc',
        secretKey: 'secret-key-b64',
        ownerToken: 'owner-token',
        name: 'test-file.bin',
        size: 1_000_000,
        expiresAt: new Date('2026-04-01T00:00:00Z'),
        downloadLimit: 5,
        downloadCount: 0,
        ...overrides,
    };
}

describe('useAppStore', () => {
    beforeEach(() => {
        // Reset store to initial state
        useAppStore.setState({
            files: [],
            uploadedFiles: [],
            toasts: [],
            encrypted: false,
            timeLimit: 86400,
            downloadLimit: 1,
            isUploading: false,
            uploadProgress: null,
            uploadError: null,
            currentCanceller: null,
            currentKeychain: null,
            zippingProgress: null,
            checkingSpeed: false,
            resumableUpload: null,
            config: null,
        });
        localStorage.clear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Initial state', () => {
        it('has encryption disabled by default', () => {
            expect(useAppStore.getState().encrypted).toBe(false);
        });

        it('has timeLimit of 86400 (1 day)', () => {
            expect(useAppStore.getState().timeLimit).toBe(86400);
        });

        it('has downloadLimit of 1', () => {
            expect(useAppStore.getState().downloadLimit).toBe(1);
        });

        it('has empty files array', () => {
            expect(useAppStore.getState().files).toEqual([]);
        });

        it('has empty toasts array', () => {
            expect(useAppStore.getState().toasts).toEqual([]);
        });

        it('is not uploading', () => {
            expect(useAppStore.getState().isUploading).toBe(false);
        });
    });

    describe('setEncrypted', () => {
        it('toggles encryption on', () => {
            useAppStore.getState().setEncrypted(true);
            expect(useAppStore.getState().encrypted).toBe(true);
        });

        it('toggles encryption off', () => {
            useAppStore.getState().setEncrypted(true);
            useAppStore.getState().setEncrypted(false);
            expect(useAppStore.getState().encrypted).toBe(false);
        });
    });

    describe('setTimeLimit', () => {
        it('updates the time limit', () => {
            useAppStore.getState().setTimeLimit(3600);
            expect(useAppStore.getState().timeLimit).toBe(3600);
        });

        it('allows setting to 0', () => {
            useAppStore.getState().setTimeLimit(0);
            expect(useAppStore.getState().timeLimit).toBe(0);
        });
    });

    describe('setDownloadLimit', () => {
        it('updates the download limit', () => {
            useAppStore.getState().setDownloadLimit(10);
            expect(useAppStore.getState().downloadLimit).toBe(10);
        });
    });

    describe('addFiles', () => {
        it('creates FileItems with pending status and unique ids', () => {
            const file1 = new File(['hello'], 'hello.txt', { type: 'text/plain' });
            const file2 = new File(['world'], 'world.txt', { type: 'text/plain' });

            useAppStore.getState().addFiles([file1, file2]);

            const { files } = useAppStore.getState();
            expect(files).toHaveLength(2);
            expect(files[0].status).toBe('pending');
            expect(files[1].status).toBe('pending');
            expect(files[0].progress).toBe(0);
            expect(files[1].progress).toBe(0);
            expect(files[0].id).not.toBe(files[1].id);
            expect(files[0].file.name).toBe('hello.txt');
            expect(files[1].file.name).toBe('world.txt');
        });

        it('appends to existing files', () => {
            const file1 = new File(['a'], 'a.txt');
            const file2 = new File(['b'], 'b.txt');

            useAppStore.getState().addFiles([file1]);
            useAppStore.getState().addFiles([file2]);

            expect(useAppStore.getState().files).toHaveLength(2);
        });
    });

    describe('removeFile', () => {
        it('removes file by id', () => {
            const file = new File(['test'], 'test.txt');
            useAppStore.getState().addFiles([file]);

            const { files } = useAppStore.getState();
            expect(files).toHaveLength(1);

            useAppStore.getState().removeFile(files[0].id);
            expect(useAppStore.getState().files).toHaveLength(0);
        });

        it('does not affect other files', () => {
            const file1 = new File(['a'], 'a.txt');
            const file2 = new File(['b'], 'b.txt');
            useAppStore.getState().addFiles([file1, file2]);

            const { files } = useAppStore.getState();
            useAppStore.getState().removeFile(files[0].id);

            const remaining = useAppStore.getState().files;
            expect(remaining).toHaveLength(1);
            expect(remaining[0].file.name).toBe('b.txt');
        });
    });

    describe('clearFiles', () => {
        it('empties the files array', () => {
            useAppStore.getState().addFiles([new File(['x'], 'x.txt')]);
            expect(useAppStore.getState().files).toHaveLength(1);

            useAppStore.getState().clearFiles();
            expect(useAppStore.getState().files).toHaveLength(0);
        });
    });

    describe('setTheme', () => {
        it('persists theme to localStorage', () => {
            useAppStore.getState().setTheme('dark');
            expect(localStorage.getItem('theme')).toBe('dark');
            expect(useAppStore.getState().theme).toBe('dark');
        });

        it('updates to light theme', () => {
            useAppStore.getState().setTheme('light');
            expect(localStorage.getItem('theme')).toBe('light');
            expect(useAppStore.getState().theme).toBe('light');
        });

        it('updates to system theme', () => {
            useAppStore.getState().setTheme('system');
            expect(localStorage.getItem('theme')).toBe('system');
            expect(useAppStore.getState().theme).toBe('system');
        });
    });

    describe('addUploadedFile', () => {
        it('prepends to the uploaded files list', () => {
            const file1 = makeUploadedFile({ id: 'first', name: 'first.txt' });
            const file2 = makeUploadedFile({ id: 'second', name: 'second.txt' });

            useAppStore.getState().addUploadedFile(file1);
            useAppStore.getState().addUploadedFile(file2);

            const { uploadedFiles } = useAppStore.getState();
            expect(uploadedFiles).toHaveLength(2);
            expect(uploadedFiles[0].id).toBe('second'); // most recent first
            expect(uploadedFiles[1].id).toBe('first');
        });

        it('persists to localStorage', () => {
            const file = makeUploadedFile({ id: 'persisted' });
            useAppStore.getState().addUploadedFile(file);

            const stored = localStorage.getItem('uploadedFiles');
            expect(stored).not.toBeNull();
            const parsed = JSON.parse(stored as string);
            expect(parsed).toHaveLength(1);
            expect(parsed[0].id).toBe('persisted');
        });
    });

    describe('removeUploadedFile', () => {
        it('removes from the list and calls deleteFile', () => {
            const file = makeUploadedFile({ id: 'to-remove', ownerToken: 'tok-123' });
            useAppStore.getState().addUploadedFile(file);

            useAppStore.getState().removeUploadedFile('to-remove');

            expect(useAppStore.getState().uploadedFiles).toHaveLength(0);
            expect(deleteFile).toHaveBeenCalledWith('to-remove', 'tok-123');
        });

        it('updates localStorage after removal', () => {
            const file = makeUploadedFile({ id: 'remove-me' });
            useAppStore.getState().addUploadedFile(file);
            useAppStore.getState().removeUploadedFile('remove-me');

            const stored = JSON.parse(localStorage.getItem('uploadedFiles') as string);
            expect(stored).toHaveLength(0);
        });
    });

    describe('updateUploadedFile', () => {
        it('updates specific fields on an uploaded file', () => {
            const file = makeUploadedFile({ id: 'update-me', downloadCount: 0 });
            useAppStore.getState().addUploadedFile(file);

            useAppStore.getState().updateUploadedFile('update-me', { downloadCount: 3 });

            const updated = useAppStore.getState().uploadedFiles.find((f) => f.id === 'update-me');
            expect(updated?.downloadCount).toBe(3);
            expect(updated?.name).toBe(file.name); // other fields unchanged
        });
    });

    describe('clearUploadedFiles', () => {
        it('removes localStorage entry and empties the list', () => {
            const file1 = makeUploadedFile({ id: 'a' });
            const file2 = makeUploadedFile({ id: 'b' });
            useAppStore.getState().addUploadedFile(file1);
            useAppStore.getState().addUploadedFile(file2);

            useAppStore.getState().clearUploadedFiles();

            expect(useAppStore.getState().uploadedFiles).toHaveLength(0);
            expect(localStorage.getItem('uploadedFiles')).toBeNull();
        });

        it('calls deleteFile for each file in background', () => {
            const file1 = makeUploadedFile({ id: 'del-1', ownerToken: 'tok-1' });
            const file2 = makeUploadedFile({ id: 'del-2', ownerToken: 'tok-2' });
            useAppStore.getState().addUploadedFile(file1);
            useAppStore.getState().addUploadedFile(file2);

            useAppStore.getState().clearUploadedFiles();

            expect(deleteFile).toHaveBeenCalledWith('del-1', 'tok-1');
            expect(deleteFile).toHaveBeenCalledWith('del-2', 'tok-2');
        });
    });

    describe('Toasts', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('adds a toast with auto-generated id', () => {
            useAppStore.getState().addToast({ title: 'Hello', variant: 'success' });
            const { toasts } = useAppStore.getState();
            expect(toasts).toHaveLength(1);
            expect(toasts[0].title).toBe('Hello');
            expect(toasts[0].variant).toBe('success');
            expect(toasts[0].id).toBeTruthy();
        });

        it('adds a toast with description', () => {
            useAppStore.getState().addToast({
                title: 'Error',
                description: 'Something went wrong',
                variant: 'destructive',
            });
            const { toasts } = useAppStore.getState();
            expect(toasts[0].description).toBe('Something went wrong');
        });

        it('auto-removes toast after 5000ms', () => {
            useAppStore.getState().addToast({ title: 'Temp' });
            expect(useAppStore.getState().toasts).toHaveLength(1);

            vi.advanceTimersByTime(4999);
            expect(useAppStore.getState().toasts).toHaveLength(1);

            vi.advanceTimersByTime(1);
            expect(useAppStore.getState().toasts).toHaveLength(0);
        });

        it('removeToast removes specific toast', () => {
            useAppStore.getState().addToast({ title: 'First' });
            useAppStore.getState().addToast({ title: 'Second' });

            const toasts = useAppStore.getState().toasts;
            expect(toasts).toHaveLength(2);

            useAppStore.getState().removeToast(toasts[0].id);
            expect(useAppStore.getState().toasts).toHaveLength(1);
            expect(useAppStore.getState().toasts[0].title).toBe('Second');
        });
    });

    describe('Upload state setters', () => {
        it('setUploading updates isUploading', () => {
            useAppStore.getState().setUploading(true);
            expect(useAppStore.getState().isUploading).toBe(true);
        });

        it('setUploadProgress updates uploadProgress', () => {
            const progress = {
                loaded: 500,
                total: 1000,
                percentage: 50,
                speed: 100,
                remainingTime: 5,
                retryCount: 0,
                isOffline: false,
                connectionQuality: 'good' as const,
            };
            useAppStore.getState().setUploadProgress(progress);
            expect(useAppStore.getState().uploadProgress).toEqual(progress);
        });

        it('setUploadError updates uploadError', () => {
            useAppStore.getState().setUploadError('Upload failed');
            expect(useAppStore.getState().uploadError).toBe('Upload failed');
        });

        it('setZippingProgress updates zippingProgress', () => {
            useAppStore.getState().setZippingProgress(42);
            expect(useAppStore.getState().zippingProgress).toBe(42);
        });

        it('setCheckingSpeed updates checkingSpeed', () => {
            useAppStore.getState().setCheckingSpeed(true);
            expect(useAppStore.getState().checkingSpeed).toBe(true);
        });
    });

    describe('Config', () => {
        it('setConfig stores the config', () => {
            const config = {
                maxFileSize: 1_000_000_000,
                maxFilesPerArchive: 100,
                maxExpireSeconds: 604800,
                maxDownloads: 100,
                defaultExpireSeconds: 86400,
                defaultDownloads: 1,
                expireTimes: [3600, 86400, 604800],
                downloadCounts: [1, 5, 10, 50],
            };
            useAppStore.getState().setConfig(config);
            expect(useAppStore.getState().config).toEqual(config);
        });

        it('setConfig handles null', () => {
            useAppStore.getState().setConfig(null);
            expect(useAppStore.getState().config).toBeNull();
        });
    });

    describe('Resumable upload', () => {
        it('setResumableUpload stores and clears', () => {
            const upload = {
                fileId: 'f1',
                uploadId: 'u1',
                ownerToken: 'o1',
                fileName: 'test.bin',
                fileSize: 1000,
                fileLastModified: 1000,
                encrypted: false,
                partSize: 10000,
                plaintextPartSize: 10000,
                completedParts: [],
                totalParts: 1,
                timeLimit: 86400,
                downloadLimit: 1,
                createdAt: Date.now(),
            };
            useAppStore.getState().setResumableUpload(upload);
            expect(useAppStore.getState().resumableUpload).toEqual(upload);

            useAppStore.getState().setResumableUpload(null);
            expect(useAppStore.getState().resumableUpload).toBeNull();
        });
    });

    describe('loadUploadedFiles with corrupted localStorage', () => {
        it('returns empty array for invalid JSON', async () => {
            // Set invalid JSON before re-importing the store module
            localStorage.setItem('uploadedFiles', '{not valid json!!!');

            // We need to re-evaluate the module to trigger loadUploadedFiles
            // Reset modules so the store is re-created
            vi.resetModules();

            // Re-mock dependencies before reimport
            vi.doMock('@/lib/api', () => ({
                deleteFile: vi.fn().mockResolvedValue(undefined),
            }));
            vi.doMock('@/lib/sentry', () => ({
                captureError: vi.fn(),
                addBreadcrumb: vi.fn(),
            }));

            const { useAppStore: freshStore } = await import('@/stores/app');
            expect(freshStore.getState().uploadedFiles).toEqual([]);
        });

        it('returns empty array when localStorage has no uploadedFiles', async () => {
            localStorage.removeItem('uploadedFiles');

            vi.resetModules();
            vi.doMock('@/lib/api', () => ({
                deleteFile: vi.fn().mockResolvedValue(undefined),
            }));
            vi.doMock('@/lib/sentry', () => ({
                captureError: vi.fn(),
                addBreadcrumb: vi.fn(),
            }));

            const { useAppStore: freshStore } = await import('@/stores/app');
            expect(freshStore.getState().uploadedFiles).toEqual([]);
        });

        it('loads valid stored files with date parsing', async () => {
            const storedFiles = [
                {
                    id: 'stored-1',
                    url: 'https://example.com/d/1',
                    secretKey: 'key',
                    ownerToken: 'tok',
                    name: 'stored.txt',
                    size: 500,
                    expiresAt: '2026-04-01T00:00:00.000Z',
                    downloadLimit: 3,
                    downloadCount: 1,
                },
            ];
            localStorage.setItem('uploadedFiles', JSON.stringify(storedFiles));

            vi.resetModules();
            vi.doMock('@/lib/api', () => ({
                deleteFile: vi.fn().mockResolvedValue(undefined),
            }));
            vi.doMock('@/lib/sentry', () => ({
                captureError: vi.fn(),
                addBreadcrumb: vi.fn(),
            }));

            const { useAppStore: freshStore } = await import('@/stores/app');
            const files = freshStore.getState().uploadedFiles;
            expect(files).toHaveLength(1);
            expect(files[0].id).toBe('stored-1');
            expect(files[0].expiresAt).toBeInstanceOf(Date);
            expect(files[0].expiresAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');
        });
    });
});
