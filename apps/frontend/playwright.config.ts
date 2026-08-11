import { defineConfig, devices } from '@playwright/test';

const PREVIEW_PORT = 4173;
const PREVIEW_ORIGIN = `http://localhost:${PREVIEW_PORT}`;

/**
 * Real-browser suite for the worker+OPFS upload engine [R17]. Runs against
 * the production build via `vite preview` — fakes cannot validate OPFS sync
 * access handles, module-worker chunk loading in the built bundle, structured
 * clone across the worker boundary, or reload recovery. No backend is
 * required: the specs mock the API and the S3 part URLs at the page level
 * (`page.route`), so the build points `VITE_API_URL` at the preview origin to
 * keep every mocked request same-origin (no CORS preflights to emulate).
 */
export default defineConfig({
    testDir: './e2e',
    // Each test pushes ~150MB through OPFS staging and mocked part PUTs — one
    // worker keeps memory bounded and the per-test network mocks isolated.
    fullyParallel: false,
    workers: 1,
    timeout: 180_000,
    expect: { timeout: 30_000 },
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? 'line' : 'list',
    use: {
        baseURL: PREVIEW_ORIGIN,
        trace: 'retain-on-failure',
    },
    /**
     * WebKit is not optional coverage here. `FileSystemHandle.move()` is
     * specified by no standard, and WebKit requires both of its arguments
     * where Chromium requires one — so the engine's part-commit rename threw
     * `TypeError: Not enough arguments` on every Safari and iOS upload while
     * a green Chromium-only suite reported the engine healthy. Any OPFS or
     * worker API the engine leans on can diverge the same way.
     */
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
    webServer: {
        command: `bunx vite build && bunx vite preview --port ${PREVIEW_PORT} --strictPort`,
        url: PREVIEW_ORIGIN,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        env: {
            VITE_API_URL: `${PREVIEW_ORIGIN}/api`,
        },
    },
});
