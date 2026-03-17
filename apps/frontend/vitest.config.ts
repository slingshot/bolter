import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
    viteConfig,
    defineConfig({
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
