import { init, track } from '@plausible-analytics/tracker';
import { track as vercelTrack } from '@vercel/analytics';
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
const safeTrack = (eventName: string, options?: { props?: Record<string, string> }) => {
    try {
        track(eventName, options ?? {});
    } catch (e) {
        console.warn(`[Plausible] Failed to track "${eventName}":`, e);
    }
};

// Vercel Web Analytics fan-out — the fallback provider, so events survive a
// Plausible outage (pageviews come from <Analytics /> in App.tsx). Fails
// silently like safeTrack so neither provider can block the other.
const safeVercelTrack = (
    eventName: string,
    props?: Record<string, string | number | boolean | undefined>,
) => {
    try {
        const defined: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(props ?? {})) {
            if (v !== undefined) {
                defined[k] = v;
            }
        }
        vercelTrack(eventName, Object.keys(defined).length > 0 ? defined : undefined);
    } catch (e) {
        console.warn(`[Vercel Analytics] Failed to track "${eventName}":`, e);
    }
};

// Typed event helpers — Plausible custom properties must be strings
export const trackUpload = (props?: { fileSize?: number; encrypted?: boolean }) => {
    const stringProps = props
        ? Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v)]))
        : undefined;
    safeTrack('Upload', { props: stringProps });
    safeVercelTrack('Upload', props);
};

export const trackDownload = (props?: { fileId?: string }) => {
    safeTrack('Download', { props });
    safeVercelTrack('Download', props);
};

export { safeTrack as track };
