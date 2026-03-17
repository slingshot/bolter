import { describe, expect, it } from 'vitest';
import { FileReadError } from '@/lib/errors';

describe('FileReadError', () => {
    it('includes the filename in the message', () => {
        const error = new FileReadError('photo.jpg', new Error('ENOENT'));
        expect(error.message).toContain('photo.jpg');
    });

    it('has name set to "FileReadError"', () => {
        const error = new FileReadError('document.pdf', new Error('gone'));
        expect(error.name).toBe('FileReadError');
    });

    it('preserves the cause', () => {
        const cause = new Error('disk removed');
        const error = new FileReadError('data.bin', cause);
        expect(error.cause).toBe(cause);
    });

    it('preserves non-Error causes', () => {
        const cause = 'string error cause';
        const error = new FileReadError('data.bin', cause);
        expect(error.cause).toBe(cause);
    });

    it('is an instance of Error', () => {
        const error = new FileReadError('file.txt', null);
        expect(error).toBeInstanceOf(Error);
    });

    it('has a descriptive message about the file being moved or deleted', () => {
        const error = new FileReadError('report.csv', new Error('not found'));
        expect(error.message).toMatch(/moved/i);
        expect(error.message).toMatch(/deleted/i);
    });

    it('has a proper stack trace', () => {
        const error = new FileReadError('stack.txt', new Error('test'));
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('FileReadError');
    });

    it('handles filenames with special characters', () => {
        const filename = 'my file (1) [copy].txt';
        const error = new FileReadError(filename, new Error('oops'));
        expect(error.message).toContain(filename);
    });

    it('handles empty filename', () => {
        const error = new FileReadError('', new Error('empty'));
        expect(error.message).toContain('""');
    });
});
