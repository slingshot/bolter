/**
 * Centralized Sentry error reporting utilities
 * Wraps Sentry SDK calls with structured context for consistent error tracking
 */

import * as Sentry from '@sentry/react';
import { scrubUrlFragment } from './url-secret';

type ErrorContext = Record<string, string | number | boolean | null | undefined>;

/**
 * Payload keys whose string values are URLs in Sentry/Replay events:
 * `request.url`, navigation breadcrumb `data.to`/`data.from`, span attributes
 * (`url.full`, `http.url`), replay performance entries, and so on.
 *
 * Scrubbing is key-driven rather than "every string containing a #" so that
 * user-facing values — error messages, filenames — are never truncated.
 */
const URL_FIELD_KEYS = new Set([
    'url',
    'href',
    'to',
    'from',
    'location',
    'referrer',
    'referer',
    'url.full',
    'http.url',
    'document.href',
    'sentry.script_url',
]);

/** Telemetry payloads are shallow; this only bounds pathological nesting. */
const MAX_SCRUB_DEPTH = 12;

function walkAndScrub(node: unknown, depth: number, seen: WeakSet<object>): void {
    if (depth > MAX_SCRUB_DEPTH || node === null || typeof node !== 'object') {
        return;
    }
    if (seen.has(node)) {
        return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
        for (const item of node) {
            walkAndScrub(item, depth + 1, seen);
        }
        return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
        if (typeof value === 'string') {
            if (value.includes('#') && URL_FIELD_KEYS.has(key.toLowerCase())) {
                record[key] = scrubUrlFragment(value);
            }
            continue;
        }
        walkAndScrub(value, depth + 1, seen);
    }
}

/**
 * Strip URL fragments from every URL-valued field of a telemetry payload,
 * at any nesting depth. Mutates in place (what Sentry's hooks expect) and
 * returns the same object.
 */
export function scrubUrlFieldsDeep<T>(payload: T): T {
    walkAndScrub(payload, 0, new WeakSet<object>());
    return payload;
}

/** A string that is a URL rather than free-form text. */
function looksLikeUrl(value: string): boolean {
    return /^(https?:)?\/\//i.test(value) || value.startsWith('/');
}

/**
 * `beforeSend` / `beforeSendTransaction` hook.
 *
 * A download link's fragment is the AES key of an end-to-end encrypted file,
 * so no URL leaving the browser may keep it. Applied on every route, not just
 * `/download`, because a stale `request.url` or navigation breadcrumb can
 * carry the fragment long after the user has moved on.
 */
export function scrubSentryEvent<T>(event: T): T {
    if (!event || typeof event !== 'object') {
        return event;
    }
    scrubUrlFieldsDeep(event);

    // Transaction names are route patterns, but a fallback naming strategy can
    // fall back to the raw URL — scrub it too.
    const named = event as { transaction?: unknown };
    if (typeof named.transaction === 'string' && named.transaction.includes('#')) {
        named.transaction = scrubUrlFragment(named.transaction);
    }
    return event;
}

/** `beforeBreadcrumb` hook — scrub before the crumb is even buffered. */
export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
    if (!breadcrumb || typeof breadcrumb !== 'object') {
        return breadcrumb;
    }
    return scrubUrlFieldsDeep(breadcrumb);
}

/**
 * `replayIntegration({ beforeAddRecordingEvent })` hook.
 *
 * Session Replay records navigation and performance entries whose
 * `description` is the full URL; those are custom recording events and can be
 * rewritten here.
 */
export function scrubReplayRecordingEvent<T>(event: T): T {
    if (!event || typeof event !== 'object') {
        return event;
    }
    scrubUrlFieldsDeep(event);

    const payload = (event as { data?: { payload?: Record<string, unknown> } }).data?.payload;
    if (payload && typeof payload.description === 'string') {
        const { description } = payload;
        if (description.includes('#') && looksLikeUrl(description)) {
            payload.description = scrubUrlFragment(description);
        }
    }
    return event;
}

/**
 * Report an error to Sentry with structured context.
 * Also logs to console for local development visibility.
 */
export function captureError(
    error: unknown,
    context?: {
        /** Where in the app the error occurred (e.g. "upload", "download", "crypto") */
        operation?: string;
        /** Additional key-value pairs attached as Sentry context */
        extra?: ErrorContext;
        /** Sentry severity level */
        level?: Sentry.SeverityLevel;
        /** Tags for filtering in Sentry dashboard */
        tags?: Record<string, string>;
    },
): void {
    const err = normalizeError(error);

    Sentry.withScope((scope) => {
        if (context?.operation) {
            scope.setTag('operation', context.operation);
        }
        if (context?.tags) {
            for (const [key, value] of Object.entries(context.tags)) {
                scope.setTag(key, value);
            }
        }
        if (context?.extra) {
            for (const [key, value] of Object.entries(context.extra)) {
                scope.setExtra(key, value ?? null);
            }
        }
        if (context?.level) {
            scope.setLevel(context.level);
        }

        Sentry.captureException(err);
    });
}

/**
 * Add a breadcrumb to the Sentry trail for debugging context.
 * Use this before operations that might fail to build a timeline.
 */
export function addBreadcrumb(
    message: string,
    options?: {
        category?: string;
        level?: Sentry.SeverityLevel;
        data?: Record<string, unknown>;
    },
): void {
    Sentry.addBreadcrumb({
        message,
        category: options?.category ?? 'app',
        level: options?.level ?? 'info',
        data: options?.data,
    });
}

/**
 * Normalize an unknown thrown value into a proper Error object.
 */
function normalizeError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    if (typeof error === 'string') {
        return new Error(error);
    }
    return new Error(String(error));
}
