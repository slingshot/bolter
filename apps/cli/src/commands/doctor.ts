/**
 * `sendfm doctor` — is this instance actually usable, and if not, which part
 * is wrong?
 *
 * Two failure modes motivate it. Bolter's `/health` only does a server-side
 * `HeadBucket`, so a bucket with a missing CORS policy or no
 * `AbortIncompleteMultipartUpload` rule reports healthy and fails at runtime.
 * And a self-hosted instance can be reachable while its API origin,
 * pre-signing or clock is misconfigured in ways that only surface after a
 * user has waited through a large upload.
 */

import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import { EXIT } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand, type Session } from '../core/session';
import { formatBytes, formatDuration } from '../ui/format';
import type { Output } from '../ui/output';
import { symbols } from '../ui/theme';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
    name: string;
    status: CheckStatus;
    detail: string;
}

export interface DoctorData {
    instance: string;
    origin: string;
    api: string;
    healthy: boolean;
    checks: Check[];
}

/** Signed URLs are time-limited, so a badly wrong local clock breaks uploads. */
const CLOCK_SKEW_WARN_SECONDS = 60;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const started = performance.now();
    const value = await fn();
    return { value, ms: Math.round(performance.now() - started) };
}

export async function runChecks(session: Session, deep: boolean): Promise<DoctorData> {
    const checks: Check[] = [];

    const discovered = await timed(() => session.instance());
    const instance = discovered.value;
    checks.push({
        name: 'discovery',
        status: 'ok',
        detail: `bolter/${instance.bolter} · protocol ${instance.protocol.version} · ${discovered.ms}ms`,
    });
    checks.push({ name: 'api', status: 'ok', detail: instance.api });

    const client = await session.client();

    // /config is the cheapest authenticated-by-nobody round trip that proves
    // the API is genuinely answering rather than a proxy returning a cached
    // discovery document.
    try {
        const config = await timed(() => client.getConfig());
        checks.push({
            name: 'api reachable',
            status: 'ok',
            detail: `${config.ms}ms`,
        });
    } catch (error) {
        checks.push({
            name: 'api reachable',
            status: 'fail',
            detail: (error as Error).message,
        });
    }

    let healthy = true;
    try {
        const response = await fetch(`${instance.api}/health`, {
            signal: AbortSignal.timeout(5000),
        });
        const body = (await response.json()) as {
            status?: string;
            checks?: Record<string, string>;
        };
        healthy = response.ok;
        checks.push({
            name: 'health',
            status: response.ok ? 'ok' : 'fail',
            detail:
                Object.entries(body.checks ?? {})
                    .map(([k, v]) => `${k} ${v}`)
                    .join(' · ') || String(body.status ?? response.status),
        });

        // The server's Date header against ours. Pre-signed URLs carry a
        // signing time, so a clock that is minutes out produces signatures S3
        // rejects — after the client has already committed to the transfer.
        const serverDate = response.headers.get('date');
        if (serverDate) {
            const skew = Math.abs(Date.parse(serverDate) - Date.now()) / 1000;
            checks.push({
                name: 'clock skew',
                status: skew > CLOCK_SKEW_WARN_SECONDS ? 'warn' : 'ok',
                detail:
                    skew > CLOCK_SKEW_WARN_SECONDS
                        ? `${formatDuration(skew)} — pre-signed URLs may be rejected`
                        : `${Math.round(skew)}s`,
            });
        }
    } catch (error) {
        healthy = false;
        checks.push({ name: 'health', status: 'fail', detail: (error as Error).message });
    }

    checks.push({
        name: 'limits',
        status: 'ok',
        detail: `${formatBytes(instance.limits.maxFileSize)} max · ${instance.limits.maxDownloads} downloads · ${formatDuration(instance.limits.maxExpireSeconds)}`,
    });
    checks.push({
        name: 'part sizing',
        status: 'ok',
        detail: `${formatBytes(instance.limits.minPartSize)} min part · up to ${instance.limits.maxParts} parts`,
    });

    if (!deep) {
        checks.push({
            name: 'pre-signed PUT',
            status: 'skip',
            detail: 'run with --deep to allocate and abort a probe upload',
        });
        return {
            instance: instance.name,
            origin: session.instanceOrigin,
            api: instance.api,
            healthy,
            checks,
        };
    }

    // Allocate a real (tiny, single-part) upload and abort it. This is the only
    // way to prove pre-signing works end to end; the abort is what keeps it
    // from leaving a record behind.
    try {
        const allocation = await client.requestUploadUrl({ fileSize: 1, encrypted: false });
        if (!allocation.useSignedUrl || !allocation.url) {
            checks.push({
                name: 'pre-signed PUT',
                status: 'fail',
                detail: 'instance declined to issue a pre-signed URL',
            });
        } else {
            const put = await fetch(allocation.url, {
                method: 'PUT',
                body: new Uint8Array([0]),
                signal: AbortSignal.timeout(15000),
            });
            const etag = put.headers.get('etag');
            checks.push({
                name: 'pre-signed PUT',
                status: put.ok ? 'ok' : 'fail',
                detail: put.ok
                    ? `accepted · ETag ${etag ? 'readable' : 'MISSING'}`
                    : `HTTP ${put.status}`,
            });
            if (put.ok && !etag) {
                // Multipart completion needs every part's ETag; without the
                // bucket exposing it, uploads fail after transferring
                // everything.
                checks.push({
                    name: 'bucket CORS',
                    status: 'warn',
                    detail: 'ETag not readable — multipart uploads will fail at completion',
                });
            }
        }
        if (allocation.id) {
            await client.abortUpload(
                allocation.id,
                allocation.uploadId ?? '',
                allocation.uploadToken,
            );
        }
    } catch (error) {
        checks.push({
            name: 'pre-signed PUT',
            status: 'fail',
            detail: (error as Error).message,
        });
    }

    return {
        instance: instance.name,
        origin: session.instanceOrigin,
        api: instance.api,
        healthy,
        checks,
    };
}

const GLYPH: Record<CheckStatus, string> = {
    ok: symbols.ok,
    warn: symbols.warn,
    fail: symbols.fail,
    skip: symbols.bullet,
};

function render(data: DoctorData, output: Output): void {
    const { theme } = output;
    const paint = {
        ok: theme.success,
        warn: theme.warning,
        fail: theme.danger,
        skip: theme.muted,
    } as const;

    output.note(theme.bold(data.instance));
    const width = data.checks.reduce((n, c) => Math.max(n, c.name.length), 0);
    for (const check of data.checks) {
        output.note(
            `  ${paint[check.status](GLYPH[check.status])} ${check.name.padEnd(width)}  ${theme.secondary(check.detail)}`,
        );
    }
    output.result(data.api);
}

export default defineCommand({
    name: 'doctor',
    description: 'Check that an instance is reachable, healthy and correctly configured',
    options: {
        ...globalOptions,
        deep: option(z.coerce.boolean().default(false), {
            description: 'Also allocate and abort a probe upload to verify pre-signing',
            argumentKind: 'flag',
        }),
    },
    handler: async ({ flags }) => {
        const code = await runCommand(
            { name: 'doctor', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<DoctorData>> => {
                const data = await runChecks(session, Boolean(flags.deep));
                const failed = data.checks.some((c) => c.status === 'fail');
                return {
                    data,
                    render: (output) => render(data, output),
                    // A failed check is a finding, not a crash: the report is
                    // the point, so it is printed in full and the process
                    // exits non-zero afterwards.
                    exitCode: failed ? EXIT.NETWORK : EXIT.OK,
                };
            },
        );
        process.exitCode = code;
    },
});
