/**
 * Centralized Sentry error reporting utilities for the backend
 * Mirrors the frontend's captureError/addBreadcrumb pattern using @sentry/bun
 */

import * as Sentry from '@sentry/bun';

type ErrorContext = Record<string, string | number | boolean | null | undefined>;

/**
 * Report an error to Sentry with structured context.
 */
export function captureError(
    error: unknown,
    context?: {
        operation?: string;
        extra?: ErrorContext;
        level?: Sentry.SeverityLevel;
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

function normalizeError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    if (typeof error === 'string') {
        return new Error(error);
    }
    return new Error(String(error));
}
