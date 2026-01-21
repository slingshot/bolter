import { init, track } from '@plausible-analytics/tracker';
import { API_BASE_URL } from './api';

// Initialize Plausible - autoCapturePageviews is enabled by default
try {
  init({
    domain: 'send.fm',
    endpoint: `${API_BASE_URL}/pl/api/event`, // Proxy through our backend
  });
} catch (e) {
  console.warn('[Plausible] Failed to initialize:', e);
}

// Safe wrapper for track that fails silently
const safeTrack = (eventName: string, options?: { props?: Record<string, unknown> }) => {
  try {
    track(eventName, options);
  } catch (e) {
    console.warn(`[Plausible] Failed to track "${eventName}":`, e);
  }
};

// Typed event helpers
export const trackUpload = (props?: { fileSize?: number; encrypted?: boolean }) => {
  safeTrack('Upload', { props });
};

export const trackDownload = (props?: { fileId?: string }) => {
  safeTrack('Download', { props });
};

export { safeTrack as track };
