/**
 * Browser fixtures for the engine suite.
 *
 * WebKit only provisions an origin private file system for a browser profile
 * that exists on disk. Under `browser.newContext()` there is no storage root,
 * and `navigator.storage.getDirectory()` rejects with `UnknownError` before a
 * single assertion runs — so a WebKit project on the default fixtures would
 * report "OPFS unavailable", fall back to the legacy pipeline, and pass while
 * testing nothing. Every spec here exists to exercise OPFS, so WebKit gets a
 * real profile directory via `launchPersistentContext`. Chromium keeps the
 * default ephemeral context, where OPFS works without one.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, test as base, expect } from '@playwright/test';

export const test = base.extend<{ context: BrowserContext }>({
    context: async ({ playwright, browserName, browser, contextOptions, launchOptions }, use) => {
        if (browserName !== 'webkit') {
            const ctx = await browser.newContext(contextOptions);
            try {
                await use(ctx);
            } finally {
                await ctx.close();
            }
            return;
        }
        const profile = await mkdtemp(join(tmpdir(), 'bolter-e2e-webkit-'));
        const ctx = await playwright.webkit.launchPersistentContext(profile, {
            ...launchOptions,
            ...contextOptions,
        });
        try {
            await use(ctx);
        } finally {
            await ctx.close();
            // The profile holds this run's OPFS staging bytes — up to a part
            // per test. Never leave it in the system temp dir.
            await rm(profile, { recursive: true, force: true });
        }
    },
    page: async ({ context }, use) => {
        // A persistent context opens with one page already; reusing it keeps
        // both projects on a single tab.
        await use(context.pages()[0] ?? (await context.newPage()));
    },
});

export { expect };
