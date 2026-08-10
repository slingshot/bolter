import { create } from 'zustand';
import { type Canceller, deleteFile, type UploadProgress } from '@/lib/api';
import type { Keychain } from '@/lib/crypto';
import { captureError } from '@/lib/sentry';
import type { PersistedUpload } from '@/lib/upload-state';

export interface FileItem {
    id: string;
    file: File;
    status: 'pending' | 'uploading' | 'completed' | 'error';
    progress: number;
    error?: string;
}

export interface UploadedFile {
    id: string;
    url: string;
    secretKey: string;
    ownerToken: string;
    name: string;
    size: number;
    expiresAt: Date;
    downloadLimit: number;
    downloadCount: number;
    /**
     * Whether the payload was end-to-end encrypted. Optional because history
     * entries persisted before this field existed carry no answer — `undefined`
     * means "unknown", and must never be rendered as "encrypted".
     */
    encrypted?: boolean;
}

/**
 * Build the shareable link for an uploaded file.
 *
 * The `#<secretKey>` fragment is only meaningful for end-to-end encrypted
 * uploads. Appending it to a plaintext upload makes the link *look* encrypted,
 * which is exactly the false assurance finding #16 describes. Legacy entries
 * (`encrypted === undefined`) keep the fragment so links shared before the flag
 * existed keep working.
 */
export function buildShareUrl(file: Pick<UploadedFile, 'url' | 'secretKey' | 'encrypted'>): string {
    if (file.encrypted === false) {
        return file.url;
    }
    return `${file.url}#${file.secretKey}`;
}

/**
 * Resolve the expiry to display/persist for a completed upload.
 *
 * The server starts the metadata TTL at `/upload/url`, not at `/upload/complete`
 * — for a resumed upload those can be days apart. `/upload/complete` therefore
 * returns the authoritative `expiresAt` (epoch ms) and `ttl` (seconds remaining);
 * prefer them, and only fall back to the local `now + timeLimit` estimate when a
 * server that predates the field is answering.
 */
export function resolveExpiresAt(
    completion: unknown,
    timeLimitSeconds: number,
    now: number = Date.now(),
): Date {
    const source = (completion ?? {}) as { expiresAt?: unknown; ttl?: unknown };

    const { expiresAt } = source;
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
        return new Date(expiresAt);
    }

    const { ttl } = source;
    if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0) {
        return new Date(now + ttl * 1000);
    }

    return new Date(now + timeLimitSeconds * 1000);
}

export interface AppState {
    // Theme
    theme: 'light' | 'dark' | 'system';
    setTheme: (theme: 'light' | 'dark' | 'system') => void;

    // Files to upload
    files: FileItem[];
    addFiles: (files: File[]) => void;
    removeFile: (id: string) => void;
    clearFiles: () => void;

    // Upload settings
    encrypted: boolean;
    setEncrypted: (encrypted: boolean) => void;
    timeLimit: number;
    setTimeLimit: (seconds: number) => void;
    downloadLimit: number;
    setDownloadLimit: (limit: number) => void;
    /**
     * Set once the user explicitly picks an expiry / download limit, so a
     * late-arriving `/config` response can seed defaults without clobbering a
     * deliberate choice.
     */
    userTouchedSettings: boolean;

    // Upload state
    isUploading: boolean;
    uploadProgress: UploadProgress | null;
    uploadError: string | null;
    currentCanceller: Canceller | null;
    currentKeychain: Keychain | null;
    zippingProgress: number | null; // 0-100 percentage while zipping multiple files
    checkingSpeed: boolean;

    setUploading: (uploading: boolean) => void;
    setUploadProgress: (progress: UploadProgress | null) => void;
    setUploadError: (error: string | null) => void;
    setCanceller: (canceller: Canceller | null) => void;
    setKeychain: (keychain: Keychain | null) => void;
    setZippingProgress: (progress: number | null) => void;
    setCheckingSpeed: (checking: boolean) => void;

    // Uploaded files history
    uploadedFiles: UploadedFile[];
    addUploadedFile: (file: UploadedFile) => void;
    /** Delete on the server, then prune locally only if the server confirmed it. */
    removeUploadedFile: (id: string) => Promise<void>;
    /** Drop a history entry locally, without attempting a server delete. */
    forgetUploadedFile: (id: string) => void;
    updateUploadedFile: (id: string, updates: Partial<UploadedFile>) => void;
    clearUploadedFiles: () => Promise<void>;

    // Resumable upload
    resumableUpload: PersistedUpload | null;
    setResumableUpload: (upload: PersistedUpload | null) => void;

    // Config
    config: {
        maxFileSize: number;
        maxFilesPerArchive: number;
        maxExpireSeconds: number;
        maxDownloads: number;
        defaultExpireSeconds: number;
        defaultDownloads: number;
        expireTimes: number[];
        downloadCounts: number[];
        customTitle?: string;
        customDescription?: string;
    } | null;
    setConfig: (config: AppState['config']) => void;

    // Toasts
    toasts: {
        id: string;
        title: string;
        description?: string;
        variant?: 'default' | 'destructive' | 'success';
    }[];
    addToast: (toast: Omit<AppState['toasts'][0], 'id'>) => void;
    removeToast: (id: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
    // Theme
    theme:
        (typeof localStorage !== 'undefined' &&
            (localStorage.getItem('theme') as AppState['theme'])) ||
        'system',
    setTheme: (theme) => {
        localStorage.setItem('theme', theme);
        set({ theme });
        applyTheme(theme);
    },

    // Files
    files: [],
    addFiles: (newFiles) => {
        const items: FileItem[] = newFiles.map((file) => ({
            id: generateUUID(),
            file,
            status: 'pending',
            progress: 0,
        }));
        set((state) => ({ files: [...state.files, ...items] }));
    },
    removeFile: (id) => set((state) => ({ files: state.files.filter((f) => f.id !== id) })),
    clearFiles: () => set({ files: [] }),

    // Settings
    encrypted: false,
    setEncrypted: (encrypted) => set({ encrypted }),
    timeLimit: 86400, // 1 day (replaced by the server default once /config loads)
    setTimeLimit: (timeLimit) => set({ timeLimit, userTouchedSettings: true }),
    downloadLimit: 1,
    setDownloadLimit: (downloadLimit) => set({ downloadLimit, userTouchedSettings: true }),
    userTouchedSettings: false,

    // Upload state
    isUploading: false,
    uploadProgress: null,
    uploadError: null,
    currentCanceller: null,
    currentKeychain: null,
    zippingProgress: null,
    checkingSpeed: false,

    setUploading: (isUploading) => set({ isUploading }),
    setUploadProgress: (uploadProgress) => set({ uploadProgress }),
    setUploadError: (uploadError) => set({ uploadError }),
    setCanceller: (currentCanceller) => set({ currentCanceller }),
    setKeychain: (currentKeychain) => set({ currentKeychain }),
    setZippingProgress: (zippingProgress) => set({ zippingProgress }),
    setCheckingSpeed: (checkingSpeed) => set({ checkingSpeed }),

    // Uploaded files
    uploadedFiles: loadUploadedFiles(),
    addUploadedFile: (file) => {
        set((state) => {
            const newFiles = [file, ...state.uploadedFiles];
            saveUploadedFiles(newFiles);
            return { uploadedFiles: newFiles };
        });
    },
    removeUploadedFile: async (id) => {
        // Find the file to get its owner token for S3 deletion
        const index = get().uploadedFiles.findIndex((f) => f.id === id);
        if (index === -1) {
            return;
        }
        const file = get().uploadedFiles[index];

        // Optimistically hide the entry so the UI stays responsive…
        set((state) => {
            const newFiles = state.uploadedFiles.filter((f) => f.id !== id);
            saveUploadedFiles(newFiles);
            return { uploadedFiles: newFiles };
        });

        // …but the ownerToken is the ONLY credential that can delete this
        // object, so it may not be discarded until the server confirms.
        const deleted = await confirmServerDelete(file);
        if (deleted) {
            return;
        }

        set((state) => {
            const newFiles = insertUploadedFileAt(state.uploadedFiles, file, index);
            saveUploadedFiles(newFiles);
            return { uploadedFiles: newFiles };
        });
        get().addToast({
            title: 'Delete failed',
            description: `"${file.name}" is still available on the server. Try removing it again.`,
            variant: 'destructive',
        });
    },
    forgetUploadedFile: (id) => {
        set((state) => {
            const newFiles = state.uploadedFiles.filter((f) => f.id !== id);
            saveUploadedFiles(newFiles);
            return { uploadedFiles: newFiles };
        });
    },
    updateUploadedFile: (id, updates) => {
        set((state) => {
            const newFiles = state.uploadedFiles.map((f) =>
                f.id === id ? { ...f, ...updates } : f,
            );
            saveUploadedFiles(newFiles);
            return { uploadedFiles: newFiles };
        });
    },
    clearUploadedFiles: async () => {
        const files = get().uploadedFiles;
        if (files.length === 0) {
            localStorage.removeItem('uploadedFiles');
            set({ uploadedFiles: [] });
            return;
        }

        // Optimistically clear, then restore whatever the server refused to
        // delete — dropping those ownerTokens would strand the objects live.
        localStorage.removeItem('uploadedFiles');
        set({ uploadedFiles: [] });

        const outcomes = await Promise.all(
            files.map(async (file, index) => ({
                file,
                index,
                deleted: await confirmServerDelete(file),
            })),
        );
        const failed = outcomes.filter((o) => !o.deleted);
        if (failed.length === 0) {
            return;
        }

        set((state) => {
            let newFiles = state.uploadedFiles;
            for (const { file, index } of failed) {
                newFiles = insertUploadedFileAt(newFiles, file, index);
            }
            saveUploadedFiles(newFiles);
            return { uploadedFiles: newFiles };
        });
        get().addToast({
            title: 'Some files could not be deleted',
            description: `${failed.length} file${failed.length === 1 ? '' : 's'} are still available on the server. Try again.`,
            variant: 'destructive',
        });
    },

    // Resumable upload
    resumableUpload: null,
    setResumableUpload: (resumableUpload) => set({ resumableUpload }),

    // Config
    config: null,
    setConfig: (config) =>
        set((state) => {
            // Seed the active upload settings from the server defaults. Without
            // this the hardcoded 86400 / 1 win, silently ignoring the admin's
            // configured defaults and rendering the Select blank whenever the
            // configured option list omits those values.
            if (!config || state.userTouchedSettings) {
                return { config };
            }
            const seeded: Partial<AppState> = { config };
            if (
                typeof config.defaultExpireSeconds === 'number' &&
                config.defaultExpireSeconds > 0
            ) {
                seeded.timeLimit = config.defaultExpireSeconds;
            }
            if (typeof config.defaultDownloads === 'number' && config.defaultDownloads > 0) {
                seeded.downloadLimit = config.defaultDownloads;
            }
            return seeded;
        }),

    // Toasts
    toasts: [],
    addToast: (toast) => {
        const id = generateUUID();
        set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
        setTimeout(() => get().removeToast(id), 5000);
    },
    removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

// Helper functions

/**
 * Ask the server to delete a file and report whether it is confirmed gone.
 *
 * `deleteFile` currently resolves `response.ok` and only rejects on a raw
 * network error, so a 401/410/500 is indistinguishable from any other non-ok
 * status here. Anything not confirmed is treated as "still live" — the entry and
 * its ownerToken are kept so the user can retry. See the PR's cross-PR contract
 * note for the richer `deleteFile` result shape this would prefer.
 */
async function confirmServerDelete(file: UploadedFile): Promise<boolean> {
    try {
        return await deleteFile(file.id, file.ownerToken);
    } catch (err) {
        console.warn('Failed to delete file from server:', err);
        captureError(err, {
            operation: 'file.delete',
            extra: { fileId: file.id },
            level: 'warning',
        });
        return false;
    }
}

/** Re-insert a restored history entry at (approximately) its original position. */
function insertUploadedFileAt(
    files: UploadedFile[],
    file: UploadedFile,
    index: number,
): UploadedFile[] {
    if (files.some((f) => f.id === file.id)) {
        return files;
    }
    const next = [...files];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, file);
    return next;
}

function loadUploadedFiles(): UploadedFile[] {
    try {
        const stored = localStorage.getItem('uploadedFiles');
        if (!stored) {
            return [];
        }
        const files = JSON.parse(stored) as Array<
            Omit<UploadedFile, 'expiresAt'> & { expiresAt: string }
        >;
        return files.map((f) => ({
            ...f,
            expiresAt: new Date(f.expiresAt),
        }));
    } catch {
        return [];
    }
}

function saveUploadedFiles(files: UploadedFile[]) {
    try {
        localStorage.setItem('uploadedFiles', JSON.stringify(files));
    } catch {
        // Ignore storage errors
    }
}

function applyTheme(theme: 'light' | 'dark' | 'system') {
    const root = document.documentElement;
    const isDark =
        theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (isDark) {
        root.classList.add('dark');
    } else {
        root.classList.remove('dark');
    }
}

// Generate UUID with fallback for older browsers (iOS Safari < 15.4)
function generateUUID(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback using crypto.getRandomValues()
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
    );
}

// Initialize theme
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    const theme = (localStorage.getItem('theme') as AppState['theme']) || 'system';
    applyTheme(theme);
}
