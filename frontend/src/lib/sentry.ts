/**
 * Centralized Sentry error reporting utilities
 * Wraps Sentry SDK calls with structured context for consistent error tracking
 */

import * as Sentry from '@sentry/react';

type ErrorContext = Record<string, string | number | boolean | null | undefined>;

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
  }
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
  }
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
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error(String(error));
}
