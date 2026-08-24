import { defineConfig } from '@bunli/core';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
    name: 'sendfm',
    version: pkg.version,
    description: pkg.description,
    commands: {
        // The compiled executable takes its name from this file, and
        // `bin` in package.json points at ./dist/sendfm.
        entry: './src/sendfm.ts',
        directory: './src/commands',
    },
    build: {
        entry: './src/sendfm.ts',
        outdir: './dist',
        /**
         * Targets are deliberately NOT listed here.
         *
         * `bunli build` reads them from this config, so listing them would
         * make the ordinary `bun run build` — the one CI runs on every push —
         * cross-compile five ~100 MB binaries. Worse, cross-compiling needs
         * `bun install --os '*' --cpu '*'` first (bun refuses to extract
         * foreign-platform packages, and @bunli/core pulls OpenTUI's native
         * libraries), so a plain checkout cannot do it at all.
         *
         * The release workflow passes `targets: all` explicitly, after that
         * install. `bun run build:all` does the same locally.
         */
        minify: true,
        /**
         * Must stay false: bunli-releaser expects per-target output
         * directories and does its own archiving. Enabling this makes it fail
         * to find the built executables.
         */
        compress: false,
    },
});
