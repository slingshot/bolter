import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureUrlFragmentSecret, scrubUrlFragment } from '@/lib/url-secret';

const setUrl = (url: string) => {
    window.history.replaceState(null, '', url);
};

describe('scrubUrlFragment', () => {
    it('returns the URL unchanged when there is no fragment', () => {
        expect(scrubUrlFragment('https://send.fm/download/abc123')).toBe(
            'https://send.fm/download/abc123',
        );
    });

    it('removes the fragment, which is where the file key lives', () => {
        expect(scrubUrlFragment('https://send.fm/download/abc123#s3cr3t')).toBe(
            'https://send.fm/download/abc123',
        );
    });

    it('keeps the query string', () => {
        expect(scrubUrlFragment('https://send.fm/download/abc?ref=mail#s3cr3t')).toBe(
            'https://send.fm/download/abc?ref=mail',
        );
    });

    it('cuts at the first # so a fragment containing # cannot survive', () => {
        expect(scrubUrlFragment('https://send.fm/d/a#key#more')).toBe('https://send.fm/d/a');
    });

    it('handles relative URLs and bare fragments', () => {
        expect(scrubUrlFragment('/download/abc#key')).toBe('/download/abc');
        expect(scrubUrlFragment('#key')).toBe('');
    });
});

describe('captureUrlFragmentSecret', () => {
    it('captures the fragment and removes it from the address bar', () => {
        setUrl('/download/cap1#s3cr3tk3y');

        expect(captureUrlFragmentSecret()).toBe('s3cr3tk3y');
        expect(window.location.hash).toBe('');
        expect(window.location.href).not.toContain('s3cr3tk3y');
        expect(window.location.pathname).toBe('/download/cap1');
    });

    it('preserves the query string while stripping the fragment', () => {
        setUrl('/download/cap2?ref=mail#anotherkey');

        expect(captureUrlFragmentSecret()).toBe('anotherkey');
        expect(window.location.search).toBe('?ref=mail');
        expect(window.location.hash).toBe('');
    });

    it('is idempotent — later calls still return the captured key', () => {
        setUrl('/download/cap3#stickykey');

        expect(captureUrlFragmentSecret()).toBe('stickykey');
        expect(captureUrlFragmentSecret()).toBe('stickykey');
        expect(captureUrlFragmentSecret()).toBe('stickykey');
        expect(window.location.hash).toBe('');
    });

    it('returns nothing for a link that never carried a key', () => {
        setUrl('/download/cap4');

        expect(captureUrlFragmentSecret()).toBe('');
    });

    it('does not reuse one file’s key for a different file', () => {
        setUrl('/download/cap5#keyforcap5');
        expect(captureUrlFragmentSecret()).toBe('keyforcap5');

        setUrl('/download/cap6');
        expect(captureUrlFragmentSecret()).toBe('');
    });
});

describe('main.tsx telemetry wiring', () => {
    const candidates = [
        resolve(process.cwd(), 'src/main.tsx'),
        resolve(process.cwd(), 'apps/frontend/src/main.tsx'),
    ];
    const mainPath = candidates.find(existsSync);
    const mainSource = readFileSync(mainPath ?? candidates[0], { encoding: 'utf-8' });

    it('strips the fragment before any telemetry SDK is initialised', () => {
        const stripImport = mainSource.indexOf("'./lib/url-secret'");
        const plausibleImport = mainSource.indexOf("'./lib/plausible'");
        const sentryInit = mainSource.search(/^Sentry\.init\(/m);

        // ES modules evaluate in import order, and Plausible sends
        // `u: location.href` from its init-time auto pageview, so the strip
        // has to be imported first and Sentry.init() runs later still.
        expect(stripImport).toBeGreaterThanOrEqual(0);
        expect(plausibleImport).toBeGreaterThan(stripImport);
        expect(sentryInit).toBeGreaterThan(stripImport);
    });

    it('registers the Sentry URL scrubbers', () => {
        expect(mainSource).toContain('beforeSend:');
        expect(mainSource).toContain('beforeSendTransaction:');
        expect(mainSource).toContain('beforeBreadcrumb:');
        expect(mainSource).toContain('beforeAddRecordingEvent:');
    });
});
