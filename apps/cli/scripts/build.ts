/**
 * Compile sendfm to standalone binaries.
 *
 * This replaces `bunli build`, which did the same work plus a check this
 * project cannot satisfy: it refused to cross-compile unless
 * `@opentui/core-<platform>` resolved inside `apps/cli/node_modules`, because
 * bunli assumes its own OpenTUI-based TUI. sendfm renders with Ink and never
 * loaded OpenTUI at runtime, so the whole `bun install --os '*' --cpu '*'`
 * dance existed to satisfy a check about a renderer that was not being used.
 *
 * What is left is what `bunli build` actually ran: one `bun build --compile`
 * per target.
 *
 *   bun run scripts/build.ts               # host platform, flat dist/sendfm
 *   bun run scripts/build.ts --all         # five targets, dist/<target>/sendfm
 *   bun run scripts/build.ts linux-x64 …   # named targets
 *
 * The output layout is a contract with the release workflow's packaging step:
 * a multi-target build writes `dist/<target>/sendfm` (`.exe` on Windows) and a
 * single-target build writes `dist/sendfm`. Flattening the multi-target case
 * would make the workflow's per-target loop silently package the same binary
 * five times under five different names.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** The release set. Must stay in step with the workflow's packaging loop. */
const ALL_TARGETS = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'windows-x64',
] as const;

const ENTRY = 'src/sendfm.ts';
const OUTDIR = 'dist';

function resolveTargets(argv: string[]): string[] {
    const named = argv.filter((a) => !a.startsWith('-'));
    if (argv.includes('--all') || named.includes('all')) {
        return [...ALL_TARGETS];
    }
    if (named.length > 0) {
        const unknown = named.filter((t) => !(ALL_TARGETS as readonly string[]).includes(t));
        if (unknown.length > 0) {
            throw new Error(
                `Unknown target(s): ${unknown.join(', ')}\nKnown: ${ALL_TARGETS.join(', ')}`,
            );
        }
        return named;
    }
    // Node reports Windows as `win32`; bun's target triples call it `windows`.
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    return [`${platform}-${process.arch}`];
}

async function compile(target: string, outfile: string): Promise<void> {
    const args = [
        'build',
        ENTRY,
        '--compile',
        '--minify',
        '--outfile',
        outfile,
        // `bun-` prefix is required; a bare `linux-x64` is not a valid target.
        '--target',
        `bun-${target}`,
    ];
    const proc = Bun.spawn(['bun', ...args], { stdout: 'inherit', stderr: 'inherit' });
    const code = await proc.exited;
    if (code !== 0) {
        throw new Error(`Compilation failed for ${target}`);
    }
}

const targets = resolveTargets(process.argv.slice(2));
const multi = targets.length > 1;

await rm(OUTDIR, { recursive: true, force: true });
await mkdir(OUTDIR, { recursive: true });

for (const target of targets) {
    const name = target.startsWith('windows') ? 'sendfm.exe' : 'sendfm';
    const dir = multi ? join(OUTDIR, target) : OUTDIR;
    if (multi) {
        await mkdir(dir, { recursive: true });
    }
    console.error(`Compiling for ${target}…`);
    await compile(target, join(dir, name));
}

console.error(`Built ${targets.length} target${targets.length === 1 ? '' : 's'} into ${OUTDIR}/`);
