/**
 * Error reporting seam.
 *
 * The protocol runs in three places that report errors completely differently:
 * a browser tab with a Sentry client, a dedicated Web Worker with none (it
 * posts failures back over its message channel), and a compiled binary that
 * writes a local trace file. Importing any one of those from here would drag
 * it into the other two — today the browser's Sentry SDK is bundled into the
 * upload worker purely because `crypto.ts` imported it, where it is inert.
 *
 * A module-level registrar rather than an options bag: reporting is genuinely
 * ambient — there is one reporter per process — and the alternative is
 * threading a telemetry parameter through every stream factory and pipeline
 * stage for a concern none of them otherwise care about.
 *
 * The default is silence, so an unconfigured consumer gets no output rather
 * than a crash, and a sink that throws is swallowed: telemetry must never be
 * the reason an upload fails.
 */

/** Matches Sentry's `SeverityLevel` so an adapter needs no translation. */
export type TelemetryLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

/**
 * Extras are serialized by every backend that consumes them, so they are
 * primitives. Widening this to `unknown` would make a host reporter that
 * accepts only primitives unassignable to `TelemetrySink`, since parameters
 * are contravariant — the wider type is the one that cannot be passed.
 */
export type TelemetryValue = string | number | boolean | null | undefined;

export interface TelemetryContext {
    /** Where in the protocol this happened, e.g. `crypto.decryptRecord`. */
    operation?: string;
    extra?: Record<string, TelemetryValue>;
    level?: TelemetryLevel;
    tags?: Record<string, string>;
}

export type TelemetrySink = (error: unknown, context?: TelemetryContext) => void;

const silent: TelemetrySink = () => {
    // Intentional: an unconfigured host gets silence, not a crash.
};

let sink: TelemetrySink = silent;

/** Install the host's reporter. Call once, as early as the host can. */
export function setTelemetrySink(next: TelemetrySink): void {
    sink = next;
}

/** Restore the silent default — for tests, and for hosts tearing down. */
export function resetTelemetrySink(): void {
    sink = silent;
}

export function reportError(error: unknown, context?: TelemetryContext): void {
    try {
        sink(error, context);
    } catch {
        // A broken reporter must not become a broken transfer.
    }
}
