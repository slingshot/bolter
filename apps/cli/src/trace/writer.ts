/**
 * Local traces, in place of telemetry.
 *
 * The web app reports to Plausible and Sentry because a browser tab leaves
 * nothing behind that a user could hand you. A CLI does, so this one sends
 * nothing anywhere: every run appends a structured trace to the state
 * directory, and `sendfm report` is what turns one into something shareable —
 * only when a person asks for it.
 *
 * Redaction happens at the point of writing, not at the point of sharing. A
 * trace that contains a signed URL is a trace that must never be pasted into an
 * issue, and relying on a later pass to remember that is how secrets escape.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { traceDir } from '../core/paths';

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TraceEvent {
    /** Milliseconds since the run started, not a wall clock. */
    t: number;
    level: TraceLevel;
    event: string;
    [key: string]: unknown;
}

export interface Tracer {
    readonly runId: string;
    readonly path: string;
    event(name: string, fields?: Record<string, unknown>, level?: TraceLevel): void;
    error(name: string, error: unknown, fields?: Record<string, unknown>): void;
    close(): void;
}

/** Keep this many trace files; older ones are deleted on startup. */
const MAX_TRACES = 20;

/**
 * Strip anything that must never leave the machine.
 *
 * Signed URLs are the sharpest edge: the query string *is* the credential, so
 * a URL is reduced to origin and path. Keys, tokens and secrets are dropped
 * outright, and absolute paths are reduced to a basename — a home directory
 * carries a real name.
 */
export function redact(value: unknown, key = ''): unknown {
    if (/secret|token|key|auth|password|cookie/i.test(key)) {
        return '[redacted]';
    }
    if (typeof value === 'string') {
        if (/^https?:\/\//.test(value)) {
            try {
                const url = new URL(value);
                // Query strings on pre-signed URLs carry the signature.
                return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`;
            } catch {
                return '[unparseable-url]';
            }
        }
        if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
            // Split on both separators rather than using node:path — its
            // `basename` follows the *host* platform, so a Windows trace read
            // on Linux would keep the whole path and leak a real name.
            const last = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
            return `…/${last}`;
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => redact(item));
    }
    if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]),
        );
    }
    return value;
}

function rotate(directory: string): void {
    try {
        const files = readdirSync(directory)
            .filter((name) => name.endsWith('.ndjson'))
            .map((name) => ({ name, at: statSync(join(directory, name)).mtimeMs }))
            .sort((a, b) => b.at - a.at);
        for (const stale of files.slice(MAX_TRACES)) {
            unlinkSync(join(directory, stale.name));
        }
    } catch {
        // Rotation is housekeeping; failing it must not fail the command.
    }
}

export function createTracer(
    command: string,
    env: NodeJS.ProcessEnv = process.env,
    now = Date.now(),
): Tracer {
    const directory = traceDir(env);
    const runId = `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${command}`;
    const path = join(directory, `${runId}.ndjson`);
    const started = now;
    let live = true;

    try {
        mkdirSync(directory, { recursive: true });
        rotate(directory);
    } catch {
        // No state directory (read-only home, sandbox): tracing degrades to a
        // no-op rather than taking the command down with it.
        live = false;
    }

    const write = (record: TraceEvent) => {
        if (!live) {
            return;
        }
        try {
            appendFileSync(path, `${JSON.stringify(record)}\n`);
        } catch {
            live = false;
        }
    };

    write({
        t: 0,
        level: 'info',
        event: 'run.start',
        command,
        version: env.SENDFM_VERSION ?? 'dev',
        platform: `${process.platform}-${process.arch}`,
    });

    return {
        runId,
        path,
        event(name, fields = {}, level = 'info') {
            write({
                t: Date.now() - started,
                level,
                event: name,
                ...(redact(fields) as Record<string, unknown>),
            });
        },
        error(name, error, fields = {}) {
            write({
                t: Date.now() - started,
                level: 'error',
                event: name,
                error: redact(error) as Record<string, unknown>,
                ...(redact(fields) as Record<string, unknown>),
            });
        },
        close() {
            write({ t: Date.now() - started, level: 'info', event: 'run.end' });
            live = false;
        },
    };
}

export function listTraces(env: NodeJS.ProcessEnv = process.env): string[] {
    const directory = traceDir(env);
    try {
        return readdirSync(directory)
            .filter((name) => name.endsWith('.ndjson'))
            .map((name) => join(directory, name))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    } catch {
        return [];
    }
}
