import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@plausible-analytics/tracker', () => ({
    init: vi.fn(),
    track: vi.fn(),
}));

vi.mock('@vercel/analytics', () => ({
    track: vi.fn(),
}));

import { track as plausibleTrack } from '@plausible-analytics/tracker';
import { track as vercelTrack } from '@vercel/analytics';
import {
    newUploadAttemptId,
    trackDownload,
    trackEngineEvent,
    trackUpload,
    trackUploadAttempt,
} from '@/lib/plausible';

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

    it('carries the engine property when provided', () => {
        trackUpload({ fileSize: 1024, encrypted: true, engine: 'worker' });

        expect(plausibleTrack).toHaveBeenCalledWith('Upload', {
            props: { fileSize: '1024', encrypted: 'true', engine: 'worker' },
        });
        expect(vercelTrack).toHaveBeenCalledWith('Upload', {
            fileSize: 1024,
            encrypted: true,
            engine: 'worker',
        });
    });
});

describe('trackUploadAttempt', () => {
    it('reports the engine decision with its reason to both providers', () => {
        trackUploadAttempt({
            engine: 'legacy',
            reason: 'kill-switch',
            attemptId: 'ua_abc123def4567',
        });

        expect(plausibleTrack).toHaveBeenCalledWith('Upload Attempt', {
            props: { engine: 'legacy', reason: 'kill-switch', attemptId: 'ua_abc123def4567' },
        });
        expect(vercelTrack).toHaveBeenCalledWith('Upload Attempt', {
            engine: 'legacy',
            reason: 'kill-switch',
            attemptId: 'ua_abc123def4567',
        });
    });

    it('omits an absent reason from both payloads', () => {
        trackUploadAttempt({ engine: 'worker', attemptId: 'ua_abc123def4567' });

        expect(plausibleTrack).toHaveBeenCalledWith('Upload Attempt', {
            props: { engine: 'worker', attemptId: 'ua_abc123def4567' },
        });
        expect(vercelTrack).toHaveBeenCalledWith('Upload Attempt', {
            engine: 'worker',
            attemptId: 'ua_abc123def4567',
        });
    });
});

describe('trackEngineEvent', () => {
    it('carries the attemptId and event to both providers', () => {
        trackEngineEvent({ attemptId: 'ua_abc123def4567', event: 'failure', detail: 'retryable' });

        expect(plausibleTrack).toHaveBeenCalledWith('Engine Event', {
            props: { attemptId: 'ua_abc123def4567', event: 'failure', detail: 'retryable' },
        });
        expect(vercelTrack).toHaveBeenCalledWith('Engine Event', {
            attemptId: 'ua_abc123def4567',
            event: 'failure',
            detail: 'retryable',
        });
    });

    it('omits an absent detail from both payloads', () => {
        trackEngineEvent({ attemptId: 'ua_abc123def4567', event: 'replay' });

        expect(plausibleTrack).toHaveBeenCalledWith('Engine Event', {
            props: { attemptId: 'ua_abc123def4567', event: 'replay' },
        });
        expect(vercelTrack).toHaveBeenCalledWith('Engine Event', {
            attemptId: 'ua_abc123def4567',
            event: 'replay',
        });
    });
});

describe('engine telemetry privacy', () => {
    it('never includes a file identifier in any payload', () => {
        trackUploadAttempt({ engine: 'worker', attemptId: newUploadAttemptId() });
        trackUploadAttempt({
            engine: 'legacy',
            reason: 'no-worker',
            attemptId: newUploadAttemptId(),
        });
        trackEngineEvent({
            attemptId: newUploadAttemptId(),
            event: 'resume',
            detail: 'replay-complete',
        });
        trackEngineEvent({
            attemptId: newUploadAttemptId(),
            event: 'persist-result',
            detail: 'granted',
        });

        for (const [, options] of vi.mocked(plausibleTrack).mock.calls) {
            const keys = Object.keys(
                (options as { props?: Record<string, string> } | undefined)?.props ?? {},
            );
            expect(keys).not.toContain('fileId');
            expect(keys).not.toContain('fileName');
            expect(keys).not.toContain('uploadId');
        }
        for (const [, props] of vi.mocked(vercelTrack).mock.calls) {
            const keys = Object.keys((props as Record<string, unknown> | undefined) ?? {});
            expect(keys).not.toContain('fileId');
            expect(keys).not.toContain('fileName');
            expect(keys).not.toContain('uploadId');
        }
    });
});

describe('newUploadAttemptId', () => {
    it('mints ua_-prefixed 13-char lowercase alphanumeric ids', () => {
        const id = newUploadAttemptId();
        expect(id).toMatch(/^ua_[a-z0-9]{13}$/);
        expect(newUploadAttemptId()).not.toBe(id);
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
