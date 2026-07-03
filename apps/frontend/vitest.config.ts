import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
    viteConfig,
    defineConfig({
        resolve: {
            alias: {
                // Ships only a `module` entry (no main/exports), which vitest's
                // node-style resolver rejects — point straight at the file
                '@plausible-analytics/tracker': fileURLToPath(
                    new URL(
                        './node_modules/@plausible-analytics/tracker/plausible.js',
                        import.meta.url,
                    ),
                ),
            },
        },
        test: {
            environment: 'happy-dom',
            setupFiles: ['./src/test/setup.ts'],
            include: ['src/**/*.test.{ts,tsx}'],
            coverage: {
                provider: 'v8',
                include: ['src/lib/**', 'src/stores/**', 'src/components/**', 'src/pages/**'],
            },
        },
    }),
);
