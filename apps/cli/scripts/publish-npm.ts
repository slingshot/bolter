/**
 * Publish sendfm to npm as a launcher plus one package per platform.
 *
 * The alternative — a single package with a `postinstall` that downloads the
 * right binary — breaks offline and air-gapped installs, needs network access
 * during `npm ci`, and hands anyone who compromises the download host a way
 * into every machine that installs it. Per-platform packages behind
 * `optionalDependencies` avoid all of that: npm resolves the one matching the
 * host's `os`/`cpu` and skips the rest, so the bytes come from the registry
 * with the registry's integrity hashes.
 */

import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Target {
    /** bunli's output directory name. */
    dir: string;
    /** npm `os` value. */
    os: string;
    /** npm `cpu` value. */
    cpu: string;
    exe: string;
}

const TARGETS: Target[] = [
    { dir: 'darwin-arm64', os: 'darwin', cpu: 'arm64', exe: 'sendfm' },
    { dir: 'darwin-x64', os: 'darwin', cpu: 'x64', exe: 'sendfm' },
    { dir: 'linux-arm64', os: 'linux', cpu: 'arm64', exe: 'sendfm' },
    { dir: 'linux-x64', os: 'linux', cpu: 'x64', exe: 'sendfm' },
    { dir: 'windows-x64', os: 'win32', cpu: 'x64', exe: 'sendfm.exe' },
];

const root = join(import.meta.dir, '..');
const dist = join(root, 'dist');
const staging = join(root, '.npm-publish');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    description: string;
    license: string;
};

const dryRun = process.argv.includes('--dry-run');

async function run(command: string[], cwd: string): Promise<void> {
    const proc = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
    const code = await proc.exited;
    if (code !== 0) {
        throw new Error(`${command.join(' ')} exited ${code}`);
    }
}

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

const optional: Record<string, string> = {};

for (const target of TARGETS) {
    const name = `${pkg.name}-${target.dir}`;
    optional[name] = pkg.version;

    const out = join(staging, name);
    await mkdir(join(out, 'bin'), { recursive: true });

    const built = join(dist, target.dir, target.exe);
    if (!(await Bun.file(built).exists())) {
        throw new Error(`Missing build output for ${target.dir}: ${built}`);
    }
    await cp(built, join(out, 'bin', target.exe));
    await chmod(join(out, 'bin', target.exe), 0o755);

    await writeFile(
        join(out, 'package.json'),
        `${JSON.stringify(
            {
                name,
                version: pkg.version,
                description: `${pkg.description} (${target.dir} binary)`,
                license: pkg.license,
                // npm skips an optional dependency whose os/cpu do not match,
                // which is exactly the selection mechanism this relies on.
                os: [target.os],
                cpu: [target.cpu],
                files: ['bin/'],
            },
            null,
            2,
        )}\n`,
    );
}

// The launcher carries no binary of its own: it execs whichever platform
// package npm actually installed.
const launcher = join(staging, pkg.name);
await mkdir(join(launcher, 'bin'), { recursive: true });
await writeFile(
    join(launcher, 'package.json'),
    `${JSON.stringify(
        {
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            license: pkg.license,
            bin: { sendfm: 'bin/sendfm.mjs' },
            files: ['bin/'],
            optionalDependencies: optional,
        },
        null,
        2,
    )}\n`,
);
await writeFile(
    join(launcher, 'bin', 'sendfm.mjs'),
    `#!/usr/bin/env node
// Resolve the platform package npm installed and exec its binary. Failing
// loudly beats a confusing "command not found": the usual cause is
// --no-optional or an unsupported platform, and neither is obvious otherwise.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const target = \`${pkg.name}-\${process.platform === 'win32' ? 'windows' : process.platform}-\${process.arch}\`;
const exe = process.platform === 'win32' ? 'sendfm.exe' : 'sendfm';

let binary;
try {
    binary = require.resolve(\`\${target}/bin/\${exe}\`);
} catch {
    console.error(
        \`sendfm has no binary for \${process.platform}-\${process.arch}.\\n\` +
            'If you installed with --no-optional, reinstall without it; otherwise this\\n' +
            'platform is not yet supported. See https://github.com/slingshot/bolter',
    );
    process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
);

// Platform packages first: the launcher's optionalDependencies must resolve
// the moment it is published, or an install racing this run gets a launcher
// with nothing behind it.
for (const name of [...Object.keys(optional), pkg.name]) {
    const args = ['npm', 'publish', '--access', 'public'];
    if (dryRun) {
        args.push('--dry-run');
    }
    await run(args, join(staging, name));
}

console.log(`Published ${pkg.name}@${pkg.version} and ${TARGETS.length} platform packages.`);
