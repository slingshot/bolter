import { create } from 'zustand';
import { type Canceller, deleteFile, getDownloadStatus, type UploadProgress } from '@/lib/api';
import type { Keychain } from '@/lib/crypto';
import { captureError } from '@/lib/sentry';
import type { PersistedUpload } from '@/lib/upload-state';

export interface FileItem {
    id: string;
    file: File;
    status: 'pending' | 'uploading' | 'completed' | 'error';
    progress: number;
    error?: string;
    /**
     * File System Access handle for this file (Chromium: top-level drag-drop
     * or `showOpenFilePicker`). Persisted with the upload engine's lease so an
     * interrupted upload can offer one-click resume — no manual re-pick.
     * Folder-traversal files and plain `<input>` picks are handleless.
     */
    handle?: FileSystemFileHandle;
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
 * The server starts the metadata TTL when `/upload/url` mints the file id and
 * never refreshes it at `/upload/complete`. Computing the expiry as
 * `Date.now() + timeLimit` at completion therefore overstates it by however long
 * the upload took — days, for an upload that was interrupted and resumed later.
 *
 * `startedAt` is the epoch ms at which the server's clock started: the moment
 * the upload was requested (fresh upload) or the persisted `createdAt` of the
 * resume record (which is stamped immediately after `/upload/url` answers).
 * Anchoring to it makes the displayed expiry match Redis, and errs early rather
 * than late — the UI never claims a file is live after the server dropped it.
 *
 * `completion` is the parsed `/upload/complete` body. The server does not send
 * an authoritative expiry today (and `api.ts` currently discards the body), so
 * the `expiresAt` / `ttl` branches below are dormant; they exist so the moment
 * either side starts supplying the field it takes precedence over the estimate,
 * with no change needed here.
 */
export function resolveExpiresAt(
    completion: unknown,
    timeLimitSeconds: number,
    startedAt: number,
    now: number = Date.now(),
): Date {
    const source = (completion ?? {}) as { expiresAt?: unknown; ttl?: unknown };

    const { expiresAt } = source;
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
        return new Date(expiresAt);
    }

    // `ttl` is "seconds remaining as of this response", so it is relative to now
    // — not to the upload start.
    const { ttl } = source;
    if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0) {
        return new Date(now + ttl * 1000);
    }

    const anchor = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : now;
    return new Date(anchor + timeLimitSeconds * 1000);
}

export interface AppState {
    // Theme
    theme: 'light' | 'dark' | 'system';
    setTheme: (theme: 'light' | 'dark' | 'system') => void;

    // Files to upload
    files: FileItem[];
    /** `handles` is positional (parallel to `files`); entries without a File
     * System Access handle pass `undefined`. */
    addFiles: (files: File[], handles?: ReadonlyArray<FileSystemFileHandle | undefined>) => void;
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

    setUploading: (uploading: boolean) => void;
    setUploadProgress: (progress: UploadProgress | null) => void;
    setUploadError: (error: string | null) => void;
    setCanceller: (canceller: Canceller | null) => void;
    setKeychain: (keychain: Keychain | null) => void;
    setZippingProgress: (progress: number | null) => void;

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
    addFiles: (newFiles, handles) => {
        const items: FileItem[] = newFiles.map((file, index) => ({
            id: generateUUID(),
            file,
            status: 'pending',
            progress: 0,
            handle: handles?.[index],
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

    setUploading: (isUploading) => set({ isUploading }),
    setUploadProgress: (uploadProgress) => set({ uploadProgress }),
    setUploadError: (uploadError) => set({ uploadError }),
    setCanceller: (currentCanceller) => set({ currentCanceller }),
    setKeychain: (currentKeychain) => set({ currentKeychain }),
    setZippingProgress: (zippingProgress) => set({ zippingProgress }),

    // Uploaded files
    uploadedFiles: loadUploadedFiles(),
    addUploadedFile: (file) => {
        set((state) => {
            const newFiles = [file, ...state.uploadedFiles];
            persistUploadedFiles(newFiles);
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

        // Optimistically hide the entry so the UI stays responsive — IN MEMORY
        // ONLY. The ownerToken is the sole credential that can delete this
        // object, so localStorage must keep it until the server confirms: if the
        // tab is closed, reloaded or crashes while the request is in flight (or
        // the request simply never answers), the token has to survive.
        markDeletePending(id, file, index);
        set((state) => ({ uploadedFiles: state.uploadedFiles.filter((f) => f.id !== id) }));

        const deleted = await confirmServerDelete(file);
        clearDeletePending(id);

        if (deleted) {
            // Confirmed gone — only now is it safe to drop the token durably.
            set((state) => {
                const newFiles = state.uploadedFiles.filter((f) => f.id !== id);
                persistUploadedFiles(newFiles);
                return { uploadedFiles: newFiles };
            });
            return;
        }

        // Restore in memory; localStorage was never pruned, so nothing to undo.
        set((state) => ({
            uploadedFiles: insertUploadedFileAt(state.uploadedFiles, file, index),
        }));
        get().addToast({
            title: 'Delete failed',
            description: `"${file.name}" is still available on the server. Try removing it again.`,
            variant: 'destructive',
        });
    },
    forgetUploadedFile: (id) => {
        set((state) => {
            const newFiles = state.uploadedFiles.filter((f) => f.id !== id);
            persistUploadedFiles(newFiles);
            return { uploadedFiles: newFiles };
        });
    },
    updateUploadedFile: (id, updates) => {
        set((state) => {
            const newFiles = state.uploadedFiles.map((f) =>
                f.id === id ? { ...f, ...updates } : f,
            );
            persistUploadedFiles(newFiles);
            return { uploadedFiles: newFiles };
        });
    },
    clearUploadedFiles: async () => {
        const files = get().uploadedFiles;
        if (files.length === 0) {
            set({ uploadedFiles: [] });
            persistUploadedFiles([]);
            return;
        }

        // Same contract as removeUploadedFile, applied to the whole list: hide
        // everything immediately, but leave localStorage alone until each delete
        // is confirmed. A crash mid-clear must not discard every ownerToken at
        // once while the objects stay live.
        files.forEach((file, index) => {
            markDeletePending(file.id, file, index);
        });
        set({ uploadedFiles: [] });

        const outcomes = await Promise.all(
            files.map(async (file) => ({ file, deleted: await confirmServerDelete(file) })),
        );

        const failed: UploadedFile[] = [];
        for (const { file, deleted } of outcomes) {
            if (deleted) {
                clearDeletePending(file.id);
            } else {
                failed.push(file);
            }
        }

        if (failed.length === 0) {
            persistUploadedFiles(get().uploadedFiles);
            return;
        }

        set((state) => {
            let newFiles = state.uploadedFiles;
            for (const file of failed) {
                const index = pendingDeletes.get(file.id)?.index ?? newFiles.length;
                newFiles = insertUploadedFileAt(newFiles, file, index);
            }
            return { uploadedFiles: newFiles };
        });
        for (const file of failed) {
            clearDeletePending(file.id);
        }
        persistUploadedFiles(get().uploadedFiles);

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
 * History entries whose server delete is in flight.
 *
 * The optimistic removal is in-memory only, so every writer that persists the
 * history has to merge these back in — otherwise a concurrent `addUploadedFile`
 * or `updateUploadedFile` would durably prune an entry whose delete has not been
 * confirmed, losing the only credential that can remove the object.
 */
const pendingDeletes = new Map<string, { file: UploadedFile; index: number }>();

function markDeletePending(id: string, file: UploadedFile, index: number) {
    pendingDeletes.set(id, { file, index });
}

function clearDeletePending(id: string) {
    pendingDeletes.delete(id);
}

/** Persist the history, keeping entries whose delete is not yet confirmed. */
function persistUploadedFiles(files: UploadedFile[]) {
    let merged = files;
    for (const { file, index } of pendingDeletes.values()) {
        merged = insertUploadedFileAt(merged, file, index);
    }
    saveUploadedFiles(merged);
}

/**
 * Ask the server to delete a file and report whether it is confirmed gone.
 *
 * `deleteFile` resolves `response.ok` and only rejects on a raw network error,
 * so every non-ok status collapses to `false` — including the very common
 * "already gone" case (the server reaps a file once its download limit is hit,
 * and `/delete` then answers 401 because the owner token it compares against was
 * deleted with the metadata). Treating that as a failed delete would leave a row
 * the user can never remove.
 *
 * So on a non-confirmation, ask an endpoint that reports absence *distinctly*:
 * `getDownloadStatus` returns `gone` only for a 404/410 and `error` for a 5xx,
 * a 401 on a live encrypted file, or a network failure — `/download/url/:id`
 * checks metadata before auth, so a deleted encrypted file still answers 404.
 * A backend outage can therefore never be mistaken for a successful delete.
 */
async function confirmServerDelete(file: UploadedFile): Promise<boolean> {
    try {
        if (await deleteFile(file.id, file.ownerToken)) {
            return true;
        }
    } catch (err) {
        console.warn('Failed to delete file from server:', err);
        captureError(err, {
            operation: 'file.delete',
            extra: { fileId: file.id },
            level: 'warning',
        });
    }

    try {
        const status = await getDownloadStatus(file.id);
        return status.status === 'gone';
    } catch {
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
