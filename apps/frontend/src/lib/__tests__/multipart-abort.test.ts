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
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

        const result = await abortServerMultipart('file-1', 'upload-1');

        expect(result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/upload/abort/file-1');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ uploadId: 'upload-1' });
    });

    // `/upload/abort/:id` answers 200 with `{ error }` when the abort fails, so
    // `response.ok` alone would report a leak as a successful cleanup.
    it('reports false for a 200 response carrying an error body', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ error: 'Failed to abort upload' }),
        });

        await expect(abortServerMultipart('file-1', 'upload-1')).resolves.toBe(false);
    });

    it('reports false when the response body is not JSON', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: () => Promise.reject(new SyntaxError('Unexpected token')),
        });

        await expect(abortServerMultipart('file-1', 'upload-1')).resolves.toBe(false);
    });

    it('reports false for a non-ok response without throwing', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

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
