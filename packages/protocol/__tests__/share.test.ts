import { describe, expect, it } from 'bun:test';
import { buildShareUrl, parseShareUrl } from '../src/share';

describe('buildShareUrl', () => {
    it('appends the secret as a fragment for an encrypted share', () => {
        expect(
            buildShareUrl({ url: 'https://send.fm/download/abc', secret: 'k3y', encrypted: true }),
        ).toBe('https://send.fm/download/abc#k3y');
    });

    it('leaves an unencrypted share fragment-free', () => {
        expect(
            buildShareUrl({ url: 'https://send.fm/download/abc', secret: 'k3y', encrypted: false }),
        ).toBe('https://send.fm/download/abc');
    });
});

describe('parseShareUrl', () => {
    it('splits origin, id and secret', () => {
        expect(parseShareUrl('https://send.fm/download/abc123#s3cret')).toEqual({
            origin: 'https://send.fm',
            id: 'abc123',
            secret: 's3cret',
        });
    });

    it('accepts a share with no fragment', () => {
        expect(parseShareUrl('https://send.fm/download/abc123').secret).toBe('');
    });

    it('accepts a trailing slash', () => {
        expect(parseShareUrl('https://send.fm/download/abc123/').id).toBe('abc123');
    });

    it('works against a self-hosted instance on a subpath origin', () => {
        expect(parseShareUrl('http://localhost:3000/download/xyz#k')).toEqual({
            origin: 'http://localhost:3000',
            id: 'xyz',
            secret: 'k',
        });
    });

    it('rejects a non-share URL rather than guessing an id', () => {
        expect(() => parseShareUrl('https://send.fm/')).toThrow(/not a Bolter share link/);
        expect(() => parseShareUrl('not a url')).toThrow(/not a valid URL/);
    });
});
