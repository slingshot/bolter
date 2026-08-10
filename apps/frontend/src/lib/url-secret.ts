/**
 * URL fragment secret handling.
 *
 * Bolter puts the AES key of an end-to-end encrypted file in the URL fragment
 * (`/download/<id>#<key>`) precisely so it never reaches a server. Browser
 * telemetry SDKs, however, report `location.href` verbatim: Sentry attaches it
 * as `request.url` on every pageload transaction, error and session replay,
 * and the Plausible tracker sends `u: location.href` on the automatic pageview
 * it fires from `init()`. The fragment therefore has to leave the address bar
 * *before* any of those SDKs run.
 *
 * That is why this module performs its capture as an import-time side effect
 * and why `main.tsx` imports it first: ES modules evaluate in import order, so
 * this runs before `./lib/plausible` initialises and before `Sentry.init()`
 * executes in the entry module's body.
 *
 * The captured secret lives in memory for the lifetime of the tab only. It is
 * deliberately never written to localStorage, sessionStorage or history.state
 * — a disk-resident copy of a file key would be a worse problem than the leak
 * this fixes. A manual reload therefore arrives without a key, and the
 * download page tells the user to reopen the original share link.
 */

/** The fragment captured for a specific path, held in memory only. */
let captured: { path: string; secret: string } | null = null;

/**
 * Remove the `#fragment` from a URL-ish string.
 *
 * Pure — used both to clean the address bar and to scrub URLs out of telemetry
 * payloads. Per RFC 3986 the first `#` always begins the fragment, so a plain
 * prefix cut is correct for absolute and relative URLs alike.
 */
export function scrubUrlFragment(url: string): string {
    const hashIndex = url.indexOf('#');
    return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

/** Rewrite the address bar to the current URL without its fragment. */
function stripFragmentFromAddressBar(): void {
    try {
        const { pathname, search } = window.location;
        // Preserve history.state so react-router's own navigation state (and
        // the back/forward entry itself) survives the rewrite.
        window.history.replaceState(window.history.state, '', `${pathname}${search}`);
    } catch {
        // Sandboxed iframes and opaque origins can reject history writes. The
        // in-memory copy is still correct; only the address bar stays dirty.
    }
}

/**
 * Capture the current URL fragment into memory and strip it from the address
 * bar. Idempotent: once stripped, later calls return the value captured for
 * the current path (React StrictMode re-renders and re-runs are safe).
 *
 * The capture is keyed by pathname so a secret captured for `/download/A` can
 * never be applied to a later `/download/B` that arrived without one.
 */
export function captureUrlFragmentSecret(): string {
    if (typeof window === 'undefined' || !window.location) {
        return '';
    }

    const path = window.location.pathname;
    const rawHash = window.location.hash;

    if (rawHash.length > 1) {
        captured = { path, secret: rawHash.slice(1) };
    } else if (captured && captured.path !== path) {
        // Navigated elsewhere without a fragment — drop the previous page's
        // secret rather than silently reusing it for a different file.
        captured = null;
    }

    if (rawHash.length > 0) {
        stripFragmentFromAddressBar();
    }

    return captured?.secret ?? '';
}

// Capture as early as possible: this runs while `main.tsx` is still resolving
// its imports, ahead of every telemetry SDK.
captureUrlFragmentSecret();
