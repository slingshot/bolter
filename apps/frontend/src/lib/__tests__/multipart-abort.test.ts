import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { abortServerMultipart } from '@/lib/multipart-abort';

describe('abortServerMultipart', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('POSTs the uploadId to /upload/abort/:id', async () => {
        fetchMock.mockResolvedValue({ ok: true });

        const result = await abortServerMultipart('file-1', 'upload-1');

        expect(result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/upload/abort/file-1');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ uploadId: 'upload-1' });
    });

    it('reports false for a non-ok response without throwing', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });

        await expect(abortServerMultipart('file-1', 'upload-1')).resolves.toBe(false);
    });

    it('never throws when the network is unavailable', async () => {
        fetchMock.mockRejectedValue(new Error('Failed to fetch'));

        await expect(abortServerMultipart('file-1', 'upload-1')).resolves.toBe(false);
    });

    it('does not call the API without both ids', async () => {
        await expect(abortServerMultipart('', 'upload-1')).resolves.toBe(false);
        await expect(abortServerMultipart('file-1', '')).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
