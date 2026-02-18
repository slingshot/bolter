import { create } from 'zustand';
import { Keychain } from '@/lib/crypto';
import { Canceller, deleteFile, type UploadProgress } from '@/lib/api';
import { captureError } from '@/lib/sentry';

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
  removeUploadedFile: (id: string) => void;
  updateUploadedFile: (id: string, updates: Partial<UploadedFile>) => void;
  clearUploadedFiles: () => void;

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
  toasts: { id: string; title: string; description?: string; variant?: 'default' | 'destructive' | 'success' }[];
  addToast: (toast: Omit<AppState['toasts'][0], 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Theme
  theme: (typeof window !== 'undefined' && localStorage.getItem('theme') as AppState['theme']) || 'system',
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
  timeLimit: 86400, // 1 day
  setTimeLimit: (timeLimit) => set({ timeLimit }),
  downloadLimit: 1,
  setDownloadLimit: (downloadLimit) => set({ downloadLimit }),

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
      saveUploadedFiles(newFiles);
      return { uploadedFiles: newFiles };
    });
  },
  removeUploadedFile: (id) => {
    // Find the file to get its owner token for S3 deletion
    const file = get().uploadedFiles.find((f) => f.id === id);
    if (file) {
      // Delete from S3 in the background (don't block UI)
      deleteFile(id, file.ownerToken).catch((err) => {
        console.warn('Failed to delete file from server:', err);
        captureError(err, { operation: 'file.delete', extra: { fileId: id }, level: 'warning' });
      });
    }

    set((state) => {
      const newFiles = state.uploadedFiles.filter((f) => f.id !== id);
      saveUploadedFiles(newFiles);
      return { uploadedFiles: newFiles };
    });
  },
  updateUploadedFile: (id, updates) => {
    set((state) => {
      const newFiles = state.uploadedFiles.map((f) =>
        f.id === id ? { ...f, ...updates } : f
      );
      saveUploadedFiles(newFiles);
      return { uploadedFiles: newFiles };
    });
  },
  clearUploadedFiles: () => {
    // Delete all files from S3 in the background
    const files = get().uploadedFiles;
    for (const file of files) {
      deleteFile(file.id, file.ownerToken).catch((err) => {
        console.warn('Failed to delete file from server:', err);
        captureError(err, { operation: 'file.delete', extra: { fileId: file.id }, level: 'warning' });
      });
    }

    localStorage.removeItem('uploadedFiles');
    set({ uploadedFiles: [] });
  },

  // Config
  config: null,
  setConfig: (config) => set({ config }),

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
function loadUploadedFiles(): UploadedFile[] {
  try {
    const stored = localStorage.getItem('uploadedFiles');
    if (!stored) return [];
    const files = JSON.parse(stored);
    return files.map((f: any) => ({
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
    (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16)
  );
}

// Initialize theme
if (typeof window !== 'undefined') {
  const theme = (localStorage.getItem('theme') as AppState['theme']) || 'system';
  applyTheme(theme);
}
