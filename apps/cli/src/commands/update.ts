/**
 * `sendfm update` — keep a standalone binary current.
 *
 * Only a binary that was installed by downloading it updates itself. A
 * Homebrew cellar path or a `node_modules` path means a package manager owns
 * the file, and writing over it would leave that manager's metadata describing
 * something that is no longer there — so those cases print the right command
 * instead of quietly diverging.
 */

import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { SendfmError } from '../core/errors';
import { globalFlagsFrom, globalOptions } from '../core/global-options';
import { type CommandResult, runCommand } from '../core/session';
import type { Output } from '../ui/output';
import { symbols } from '../ui/theme';

const REPO = 'slingshot/bolter';

export type InstallMethod = 'homebrew' | 'npm' | 'docker' | 'standalone' | 'source';

export interface UpdateData {
    current: string;
    latest: string | null;
    upToDate: boolean;
    method: InstallMethod;
    /** What actually happened, or what the user should run instead. */
    action: 'updated' | 'up-to-date' | 'checked' | 'delegated';
    command?: string;
    path: string;
}

/**
 * Infer how this binary got here.
 *
 * Path-based rather than build-flag based, because the same artifact is
 * installed every way: the tarball from GitHub, a Homebrew formula that
 * unpacks it, and an npm package that ships it are all the same bytes.
 */
export function detectInstallMethod(execPath: string, env: NodeJS.ProcessEnv): InstallMethod {
    if (env.SENDFM_INSTALL_METHOD) {
        return env.SENDFM_INSTALL_METHOD as InstallMethod;
    }
    if (/[\\/](Cellar|linuxbrew)[\\/]/.test(execPath) || /[\\/]homebrew[\\/]/.test(execPath)) {
        return 'homebrew';
    }
    if (execPath.includes('node_modules')) {
        return 'npm';
    }
    if (env.container === 'docker' || env.KUBERNETES_SERVICE_HOST) {
        return 'docker';
    }
    // `bun run src/sendfm.ts` during development: the running file is source,
    // not a compiled binary, and there is nothing to replace.
    if (execPath.endsWith('bun') || execPath.endsWith('bun.exe')) {
        return 'source';
    }
    return 'standalone';
}

/** Semver comparison, tolerant of a leading `v`. */
export function isNewer(candidate: string, current: string): boolean {
    const parse = (value: string) =>
        value
            .replace(/^v/, '')
            .split('.')
            .map((part) => Number.parseInt(part, 10) || 0);
    const [a, b] = [parse(candidate), parse(current)];
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) {
            return (a[i] ?? 0) > (b[i] ?? 0);
        }
    }
    return false;
}

export interface ReleaseInfo {
    version: string;
    assetUrl: string;
    checksumsUrl: string;
    assetName: string;
}

export function assetNameFor(version: string, platform = process.platform, arch = process.arch) {
    const os = platform === 'win32' ? 'windows' : platform;
    const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
    const extension = platform === 'win32' ? 'zip' : 'tar.gz';
    return `sendfm-${version}-${os}-${cpu}.${extension}`;
}

export async function latestRelease(
    fetchImpl: typeof fetch = fetch,
): Promise<{ version: string } | null> {
    const response = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        return null;
    }
    const body = (await response.json()) as { tag_name?: string };
    return body.tag_name ? { version: body.tag_name.replace(/^v/, '') } : null;
}

const HINTS: Record<InstallMethod, string | undefined> = {
    homebrew: 'brew upgrade sendfm',
    npm: 'npm install -g sendfm@latest',
    docker: 'docker pull ghcr.io/slingshot/sendfm:latest',
    source: 'git pull',
    standalone: undefined,
};

/**
 * Replace the running executable.
 *
 * On macOS and Linux a rename over a running binary is safe — the running
 * process keeps its inode, and the next invocation gets the new file. Windows
 * locks a running image, so the old one is moved aside first and swept on the
 * next run.
 */
async function replaceBinary(execPath: string, bytes: Uint8Array): Promise<void> {
    const directory = dirname(execPath);
    // Staged in the same directory so the rename is atomic; across filesystems
    // it would degrade to a copy, and a half-written binary is unrunnable.
    const staged = join(directory, `.sendfm-update-${process.pid}`);
    await writeFile(staged, bytes, { mode: 0o755 });
    await chmod(staged, 0o755);

    if (process.platform === 'win32') {
        const displaced = `${execPath}.old`;
        await rm(displaced, { force: true });
        await rename(execPath, displaced);
    }
    await rename(staged, execPath);
}

function render(data: UpdateData, output: Output): void {
    const { theme } = output;
    if (data.action === 'delegated') {
        output.note(
            `${theme.warning(symbols.warn)} ${data.current} is installed by ${data.method}.`,
        );
        output.note(`  Update it with: ${theme.bold(data.command ?? '')}`);
        output.result(data.command ?? '');
        return;
    }
    if (data.upToDate) {
        output.note(`${theme.success(symbols.ok)} sendfm ${data.current} is current.`);
        output.result(data.current);
        return;
    }
    if (data.action === 'checked') {
        output.note(
            `${theme.warning(symbols.warn)} sendfm ${data.latest} is available (you have ${data.current}).`,
        );
        output.note(`  Run ${theme.bold('sendfm update')} to install it.`);
        output.result(data.latest ?? data.current);
        return;
    }
    output.note(
        `${theme.success(symbols.ok)} Updated sendfm ${data.current} ${symbols.arrow} ${data.latest}`,
    );
    output.result(data.latest ?? data.current);
}

export default defineCommand({
    name: 'update',
    description: 'Update sendfm to the latest release',
    options: {
        ...globalOptions,
        check: option(z.coerce.boolean().default(false), {
            description: 'Only report whether an update exists',
            argumentKind: 'flag',
        }),
    },
    handler: async ({ flags }) => {
        const code = await runCommand(
            { name: 'update', flags: globalFlagsFrom(flags) },
            async (session): Promise<CommandResult<UpdateData>> => {
                const execPath = process.execPath;
                const method = detectInstallMethod(execPath, session.env);
                const current = pkg.version;

                const release = await latestRelease();
                const latest = release?.version ?? null;
                const upToDate = latest === null || !isNewer(latest, current);

                if (method !== 'standalone') {
                    const data: UpdateData = {
                        current,
                        latest,
                        upToDate,
                        method,
                        action: upToDate ? 'up-to-date' : 'delegated',
                        command: HINTS[method],
                        path: execPath,
                    };
                    return { data, render: (output) => render(data, output) };
                }

                if (upToDate || flags.check) {
                    const data: UpdateData = {
                        current,
                        latest,
                        upToDate,
                        method,
                        action: upToDate ? 'up-to-date' : 'checked',
                        path: execPath,
                    };
                    return { data, render: (output) => render(data, output) };
                }

                await installRelease(latest as string, execPath);
                const data: UpdateData = {
                    current,
                    latest,
                    upToDate: false,
                    method,
                    action: 'updated',
                    path: execPath,
                };
                return { data, render: (output) => render(data, output) };
            },
        );
        process.exitCode = code;
    },
});

/** Download, verify against checksums.txt, and swap the binary in. */
export async function installRelease(version: string, execPath: string): Promise<void> {
    const assetName = assetNameFor(version);
    const base = `https://github.com/${REPO}/releases/download/v${version}`;

    const [archive, checksums] = await Promise.all([
        fetch(`${base}/${assetName}`).then((r) => {
            if (!r.ok) {
                throw new SendfmError('NETWORK', `Could not download ${assetName}`, {
                    retryable: true,
                });
            }
            return r.arrayBuffer();
        }),
        fetch(`${base}/checksums.txt`).then((r) => (r.ok ? r.text() : '')),
    ]);

    // A self-updater that skips verification is a remote code execution
    // primitive, so a missing or mismatched checksum aborts rather than warns.
    const expected = checksums
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([, name]) => name === assetName)?.[0];
    if (!expected) {
        throw new SendfmError('NETWORK', `No checksum published for ${assetName}`, {
            hint: 'Install manually from the releases page instead.',
        });
    }
    const digest = await crypto.subtle.digest('SHA-256', archive);
    const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) {
        throw new SendfmError('NETWORK', 'Checksum mismatch — refusing to install.', {
            details: { expected, actual },
        });
    }

    const staging = join(dirname(execPath), `.sendfm-unpack-${process.pid}`);
    await Bun.write(join(staging, assetName), archive);
    const unpack =
        process.platform === 'win32'
            ? ['unzip', '-o', join(staging, assetName), '-d', staging]
            : ['tar', '-xzf', join(staging, assetName), '-C', staging];
    const result = Bun.spawnSync(unpack);
    if (result.exitCode !== 0) {
        await rm(staging, { recursive: true, force: true });
        throw new SendfmError('LOCAL_STATE', 'Could not unpack the downloaded release.');
    }

    const binaryName = process.platform === 'win32' ? 'sendfm.exe' : 'sendfm';
    const extracted = join(staging, binaryName);
    const bytes = new Uint8Array(await Bun.file(extracted).arrayBuffer());
    await replaceBinary(execPath, bytes);
    await rm(staging, { recursive: true, force: true });
}
