import { init, track } from '@plausible-analytics/tracker';
import { track as vercelTrack } from '@vercel/analytics';

// Deliberately not imported from `./api`: the engine client (`upload-engine/
// client.ts`) emits telemetry through this module, and api.ts imports the
// engine client — importing api.ts back from here would close a circular
// import whose init-time `API_BASE_URL` read races module evaluation order.
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Initialize Plausible - autoCapturePageviews is enabled by default. Skipped
// under vitest so importing this module in unit tests never opens a network
// path.
if (import.meta.env.MODE !== 'test') {
    try {
        init({
            domain: 'send.fm',
            endpoint: `${API_BASE_URL}/pl/api/event`, // Proxy through our backend
        });
    } catch (e) {
        console.warn('[Plausible] Failed to initialize:', e);
    }
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

// Plausible custom properties must be strings; undefined values are dropped
// rather than stringified.
const toStringProps = (
    props: Record<string, string | number | boolean | undefined>,
): Record<string, string> =>
    Object.fromEntries(
        Object.entries(props)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
    );

/**
 * Random per-attempt correlation id for upload telemetry [R16]: `ua_` +
 * 13-char lowercase alphanumeric nanoid. Never a file identifier — events
 * correlate on this id alone.
 */
export const newUploadAttemptId = (): string => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(13);
    globalThis.crypto.getRandomValues(bytes);
    let id = 'ua_';
    for (const byte of bytes) {
        id += alphabet[byte % alphabet.length];
    }
    return id;
};

// Typed event helpers — Plausible custom properties must be strings
export const trackUpload = (props?: {
    fileSize?: number;
    encrypted?: boolean;
    engine?: 'worker' | 'legacy';
}) => {
    const stringProps = props ? toStringProps(props) : undefined;
    safeTrack('Upload', { props: stringProps });
    safeVercelTrack('Upload', props);
};

/**
 * One event per delegation decision: which engine this upload attempt will
 * use, and (for `legacy`) the eligibility/fallback reason [R16].
 */
export const trackUploadAttempt = (props: {
    engine: 'worker' | 'legacy';
    reason?: string;
    attemptId: string;
}) => {
    safeTrack('Upload Attempt', { props: toStringProps(props) });
    safeVercelTrack('Upload Attempt', props);
};

/**
 * Worker-engine lifecycle events, correlated to their attempt by `attemptId`
 * only — never a file identifier [R16]. This data is the evidence for
 * eventually deleting the legacy pipeline.
 */
export const trackEngineEvent = (props: {
    attemptId: string;
    event: 'failure' | 'resume' | 'cancel' | 'replay' | 'persist-result';
    detail?: string;
}) => {
    safeTrack('Engine Event', { props: toStringProps(props) });
    safeVercelTrack('Engine Event', props);
};

export const trackDownload = (props?: { fileId?: string }) => {
    safeTrack('Download', { props });
    safeVercelTrack('Download', props);
};

export { safeTrack as track };
