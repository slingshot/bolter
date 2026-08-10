import { describe, expect, it } from 'vitest';
import {
    scrubReplayRecordingEvent,
    scrubSentryBreadcrumb,
    scrubSentryEvent,
    scrubUrlFieldsDeep,
} from '@/lib/sentry';

const KEY = 'Ap5Ku2Yc0X9nQ3vHhZ7Lqw';
const DOWNLOAD_URL = `https://send.fm/download/abc123#${KEY}`;

describe('scrubSentryEvent', () => {
    it('removes the key fragment from request.url', () => {
        const event = { request: { url: DOWNLOAD_URL } };

        scrubSentryEvent(event);

        expect(event.request.url).toBe('https://send.fm/download/abc123');
        expect(JSON.stringify(event)).not.toContain(KEY);
    });

    it('removes the key from navigation breadcrumbs', () => {
        const event = {
            breadcrumbs: [
                { category: 'navigation', data: { from: '/', to: `/download/abc123#${KEY}` } },
                { category: 'fetch', data: { url: 'https://send.fm/api/metadata/abc123' } },
            ],
        };

        scrubSentryEvent(event);

        expect(event.breadcrumbs[0].data.to).toBe('/download/abc123');
        expect(event.breadcrumbs[1].data.url).toBe('https://send.fm/api/metadata/abc123');
        expect(JSON.stringify(event)).not.toContain(KEY);
    });

    it('removes the key from span attributes on a pageload transaction', () => {
        const event = {
            type: 'transaction',
            transaction: `/download/abc123#${KEY}`,
            contexts: { trace: { data: { 'url.full': DOWNLOAD_URL } } },
            spans: [{ description: 'GET /api/config', data: { 'http.url': DOWNLOAD_URL } }],
        };

        scrubSentryEvent(event);

        expect(event.transaction).toBe('/download/abc123');
        expect(event.contexts.trace.data['url.full']).toBe('https://send.fm/download/abc123');
        expect(event.spans[0].data['http.url']).toBe('https://send.fm/download/abc123');
        expect(JSON.stringify(event)).not.toContain(KEY);
    });

    it('scrubs every route, not just /download', () => {
        const event = { request: { url: `https://send.fm/?utm=x#${KEY}` } };

        scrubSentryEvent(event);

        expect(event.request.url).toBe('https://send.fm/?utm=x');
    });

    it('leaves non-URL values that contain a # alone', () => {
        const event = {
            request: { url: DOWNLOAD_URL },
            extra: { errorMessage: 'Upload of report #12 failed', fileName: 'notes #3.txt' },
        };

        scrubSentryEvent(event);

        expect(event.extra.errorMessage).toBe('Upload of report #12 failed');
        expect(event.extra.fileName).toBe('notes #3.txt');
        expect(event.request.url).toBe('https://send.fm/download/abc123');
    });

    it('survives cyclic payloads', () => {
        const event: Record<string, unknown> = { request: { url: DOWNLOAD_URL } };
        event.self = event;

        expect(() => scrubSentryEvent(event)).not.toThrow();
        expect((event.request as { url: string }).url).toBe('https://send.fm/download/abc123');
    });

    it('tolerates null and non-object events', () => {
        expect(scrubSentryEvent(null)).toBeNull();
        expect(scrubSentryEvent(undefined)).toBeUndefined();
    });
});

describe('scrubSentryBreadcrumb', () => {
    it('strips the key before the crumb is buffered', () => {
        const crumb = { category: 'navigation', data: { to: DOWNLOAD_URL } };

        scrubSentryBreadcrumb(crumb);

        expect(crumb.data.to).toBe('https://send.fm/download/abc123');
    });
});

describe('scrubReplayRecordingEvent', () => {
    it('strips the key from a replay navigation performance entry', () => {
        const event = {
            type: 5,
            data: {
                tag: 'performanceSpan',
                payload: {
                    op: 'navigation.navigate',
                    description: DOWNLOAD_URL,
                    data: { size: 1024 },
                },
            },
        };

        scrubReplayRecordingEvent(event);

        expect(event.data.payload.description).toBe('https://send.fm/download/abc123');
    });

    it('strips the key from a replay navigation breadcrumb', () => {
        const event = {
            type: 5,
            data: {
                tag: 'breadcrumb',
                payload: { category: 'navigation', data: { from: '/', to: DOWNLOAD_URL } },
            },
        };

        scrubReplayRecordingEvent(event);

        expect(event.data.payload.data.to).toBe('https://send.fm/download/abc123');
    });

    it('leaves a free-text description that merely contains a # alone', () => {
        const event = {
            type: 5,
            data: { tag: 'breadcrumb', payload: { description: 'clicked button #submit' } },
        };

        scrubReplayRecordingEvent(event);

        expect(event.data.payload.description).toBe('clicked button #submit');
    });
});

describe('scrubUrlFieldsDeep', () => {
    it('reaches URL fields nested several levels down', () => {
        const payload = { a: { b: { c: [{ href: DOWNLOAD_URL }] } } };

        scrubUrlFieldsDeep(payload);

        expect(payload.a.b.c[0].href).toBe('https://send.fm/download/abc123');
    });

    it('returns the same object it was given', () => {
        const payload = { url: DOWNLOAD_URL };

        expect(scrubUrlFieldsDeep(payload)).toBe(payload);
    });
});
