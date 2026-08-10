import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) {
        return '0 Bytes';
    }

    const k = 1000;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Format seconds to human readable duration
 */
export function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    }
    if (seconds < 3600) {
        return `${Math.round(seconds / 60)}m`;
    }
    if (seconds < 86400) {
        return `${Math.round(seconds / 3600)}h`;
    }
    return `${Math.round(seconds / 86400)}d`;
}

/**
 * Format time limit for display
 */
export function formatTimeLimit(seconds: number): string {
    if (seconds < 60) {
        return `${seconds} second${seconds === 1 ? '' : 's'}`;
    }
    if (seconds < 3600) {
        const mins = Math.round(seconds / 60);
        return `${mins} minute${mins === 1 ? '' : 's'}`;
    }
    if (seconds < 86400) {
        const hrs = Math.round(seconds / 3600);
        return `${hrs} hour${hrs === 1 ? '' : 's'}`;
    }
    if (seconds < 86400 * 30) {
        const days = Math.round(seconds / 86400);
        return `${days} day${days === 1 ? '' : 's'}`;
    }
    const months = Math.round(seconds / (86400 * 30));
    return `${months} month${months === 1 ? '' : 's'}`;
}

/**
 * Format download limit for display
 */
export function formatDownloadLimit(limit: number): string {
    if (limit === 1) {
        return '1 download';
    }
    return `${limit} downloads`;
}

/**
 * Format speed to human readable string (rounded to 1 decimal)
 */
export function formatSpeed(bytesPerSecond: number): string {
    return `${formatBytes(bytesPerSecond, 1)}/s`;
}

/**
 * Delay execution
 */
export function delay(ms: number = 100): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Copy text to clipboard
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const result = document.execCommand('copy');
        document.body.removeChild(textarea);
        return result;
    }
}

/**
 * Marker for placeholder Blobs standing in for a payload that has already been
 * streamed to disk (File System Access / service-worker download stream).
 *
 * `Symbol.for` keeps the marker stable even if this module is instantiated
 * twice (duplicated chunk, test module registry).
 */
const SAVED_TO_DISK = Symbol.for('bolter.saved-to-disk');

/**
 * Tag a placeholder Blob as "already written to disk" so `triggerDownload`
 * does not save a second, empty copy on top of the streamed file.
 */
export function markSavedToDisk<T extends Blob>(blob: T): T {
    Object.defineProperty(blob, SAVED_TO_DISK, {
        value: true,
        enumerable: false,
        configurable: true,
    });
    return blob;
}

/** True when the Blob is a placeholder for a payload already saved to disk. */
export function isSavedToDisk(blob: Blob): boolean {
    return (blob as unknown as Record<symbol, unknown>)[SAVED_TO_DISK] === true;
}

/**
 * Trigger file download
 */
export function triggerDownload(blob: Blob, filename: string): void {
    // Streaming saves (File System Access API / service-worker download
    // stream) have already delivered the bytes; the returned Blob is an empty
    // placeholder and object-URL-saving it would overwrite the real file with
    // 0 bytes.
    if (isSavedToDisk(blob)) {
        return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking synchronously lets WebKit cancel the not-yet-started blob navigation
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Get file extension
 */
export function getFileExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop()?.toLowerCase() || '' : '';
}

/**
 * Get file icon based on type
 */
export function getFileIcon(type: string): string {
    if (type.startsWith('image/')) {
        return 'image';
    }
    if (type.startsWith('video/')) {
        return 'video';
    }
    if (type.startsWith('audio/')) {
        return 'audio';
    }
    if (type.startsWith('text/')) {
        return 'file-text';
    }
    if (type.includes('pdf')) {
        return 'file-text';
    }
    if (type.includes('zip') || type.includes('archive')) {
        return 'archive';
    }
    return 'file';
}
