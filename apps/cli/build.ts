/**
 * Cross-platform compilation script for Bolter CLI.
 * Produces standalone binaries for macOS and Linux using Bun's --compile flag.
 */

const targets = [
    { target: 'bun-darwin-arm64', suffix: 'darwin-arm64' },
    { target: 'bun-darwin-x64', suffix: 'darwin-x64' },
    { target: 'bun-linux-arm64', suffix: 'linux-arm64' },
    { target: 'bun-linux-x64', suffix: 'linux-x64' },
] as const;

console.log('Building Bolter CLI binaries...\n');

let failures = 0;

for (const { target, suffix } of targets) {
    const outfile = `dist/bolter-${suffix}`;
    const label = `bolter-${suffix}`;

    process.stdout.write(`  ${label} ... `);

    const result = Bun.spawnSync(
        [
            'bun',
            'build',
            '--compile',
            `--target=${target}`,
            '--minify',
            './cli.ts',
            '--outfile',
            outfile,
        ],
        { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
    );

    if (result.exitCode === 0) {
        console.log('\x1b[32m\u2714\x1b[0m');
    } else {
        console.log('\x1b[31m\u2718\x1b[0m');
        const stderr = result.stderr.toString().trim();
        if (stderr) {
            console.error(`    ${stderr}`);
        }
        failures++;
    }
}

console.log();

if (failures > 0) {
    console.error(`\x1b[31m${failures} target(s) failed.\x1b[0m`);
    process.exit(1);
} else {
    console.log(`\x1b[32mAll ${targets.length} binaries built successfully.\x1b[0m`);
}
