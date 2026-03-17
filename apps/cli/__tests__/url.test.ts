import { describe, expect, test } from 'bun:test';
import { parseBolterUrl } from '../lib/url';

describe('parseBolterUrl', () => {
    test('parses full frontend URL with hash key', () => {
        const result = parseBolterUrl('https://send.fm/download/abc123#secretKey');
        expect(result).toEqual({ fileId: 'abc123', secretKey: 'secretKey' });
    });

    test('parses full API URL with hash key', () => {
        const result = parseBolterUrl('https://api.send.fm/download/abc123#secretKey');
        expect(result).toEqual({ fileId: 'abc123', secretKey: 'secretKey' });
    });

    test('parses URL with port', () => {
        const result = parseBolterUrl('http://localhost:3001/download/abc123#key');
        expect(result).toEqual({ fileId: 'abc123', secretKey: 'key' });
    });

    test('parses URL without hash fragment', () => {
        const result = parseBolterUrl('https://send.fm/download/abc123');
        expect(result).toEqual({ fileId: 'abc123', secretKey: null });
    });

    test('parses bare file ID', () => {
        const result = parseBolterUrl('abc123');
        expect(result).toEqual({ fileId: 'abc123', secretKey: null });
    });

    test('parses bare file ID with hash key', () => {
        const result = parseBolterUrl('abc123#secretKey');
        expect(result).toEqual({ fileId: 'abc123', secretKey: 'secretKey' });
    });

    test('treats empty hash as null secret key', () => {
        const result = parseBolterUrl('https://send.fm/download/abc123#');
        expect(result).toEqual({ fileId: 'abc123', secretKey: null });
    });

    test('handles URL-safe base64 key with dashes and underscores', () => {
        const key = 'aB3-cD4_eF5-gH6_iJ7';
        const result = parseBolterUrl(`https://send.fm/download/abc123#${key}`);
        expect(result).toEqual({ fileId: 'abc123', secretKey: key });
    });

    test('handles long hex file IDs', () => {
        const longId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
        const result = parseBolterUrl(`https://send.fm/download/${longId}#key123`);
        expect(result).toEqual({ fileId: longId, secretKey: 'key123' });
    });

    test('handles bare long hex file ID', () => {
        const longId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
        const result = parseBolterUrl(longId);
        expect(result).toEqual({ fileId: longId, secretKey: null });
    });

    test('trims whitespace from input', () => {
        const result = parseBolterUrl('  abc123#secretKey  ');
        expect(result).toEqual({ fileId: 'abc123', secretKey: 'secretKey' });
    });

    test('handles empty hash on bare ID', () => {
        const result = parseBolterUrl('abc123#');
        expect(result).toEqual({ fileId: 'abc123', secretKey: null });
    });

    test('handles URL without /download/ segment', () => {
        const result = parseBolterUrl('https://send.fm/abc123#key');
        expect(result).toEqual({ fileId: 'abc123', secretKey: 'key' });
    });

    test('handles localhost frontend URL', () => {
        const result = parseBolterUrl('http://localhost:3000/download/abc123#secretKey');
        expect(result).toEqual({ fileId: 'abc123', secretKey: 'secretKey' });
    });

    test('handles complex key with special URL-safe base64 characters', () => {
        const key = 'X9f-Kp_2Lm-Qr_4Ts-Uv_6Wx-Yz_8';
        const result = parseBolterUrl(`abc123#${key}`);
        expect(result).toEqual({ fileId: 'abc123', secretKey: key });
    });

    test('parses URL with nested path before /download/', () => {
        const result = parseBolterUrl('https://send.fm/app/download/fileXYZ#mykey');
        expect(result).toEqual({ fileId: 'fileXYZ', secretKey: 'mykey' });
    });

    test('handles empty input as bare ID', () => {
        const result = parseBolterUrl('');
        expect(result).toEqual({ fileId: '', secretKey: null });
    });
});
