import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@plausible-analytics/tracker', () => ({
    init: vi.fn(),
    track: vi.fn(),
}));

vi.mock('@vercel/analytics', () => ({
    track: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
    API_BASE_URL: 'http://localhost:3001',
}));

import { track as plausibleTrack } from '@plausible-analytics/tracker';
import { track as vercelTrack } from '@vercel/analytics';
import { trackDownload, trackUpload } from '@/lib/plausible';

beforeEach(() => {
    vi.mocked(plausibleTrack).mockReset();
    vi.mocked(vercelTrack).mockReset();
});

describe('trackUpload', () => {
    it('reports to Plausible with stringified props', () => {
        trackUpload({ fileSize: 1024, encrypted: true });

        expect(plausibleTrack).toHaveBeenCalledWith('Upload', {
            props: { fileSize: '1024', encrypted: 'true' },
        });
    });

    it('reports to Vercel Analytics with native-typed props', () => {
        trackUpload({ fileSize: 1024, encrypted: true });

        expect(vercelTrack).toHaveBeenCalledWith('Upload', {
            fileSize: 1024,
            encrypted: true,
        });
    });

    it('omits undefined props from the Vercel payload', () => {
        trackUpload({ fileSize: 2048, encrypted: undefined });

        expect(vercelTrack).toHaveBeenCalledWith('Upload', { fileSize: 2048 });
    });

    it('reports to both providers without props', () => {
        trackUpload();

        expect(plausibleTrack).toHaveBeenCalledWith('Upload', { props: undefined });
        expect(vercelTrack).toHaveBeenCalledWith('Upload', undefined);
    });
});

describe('trackDownload', () => {
    it('reports to both providers', () => {
        trackDownload({ fileId: 'abc123' });

        expect(plausibleTrack).toHaveBeenCalledWith('Download', {
            props: { fileId: 'abc123' },
        });
        expect(vercelTrack).toHaveBeenCalledWith('Download', { fileId: 'abc123' });
    });
});

describe('provider isolation', () => {
    it('still reports to Vercel when Plausible throws', () => {
        vi.mocked(plausibleTrack).mockImplementation(() => {
            throw new Error('plausible down');
        });

        expect(() => trackUpload({ fileSize: 1, encrypted: false })).not.toThrow();
        expect(vercelTrack).toHaveBeenCalledTimes(1);
    });

    it('still reports to Plausible when Vercel throws', () => {
        vi.mocked(vercelTrack).mockImplementation(() => {
            throw new Error('vercel down');
        });

        expect(() => trackDownload({ fileId: 'x' })).not.toThrow();
        expect(plausibleTrack).toHaveBeenCalledTimes(1);
    });
});
