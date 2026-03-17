import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTempFile, generateZipFilename, zipFiles } from '../lib/zip';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory and populate it with test files. */
async function makeTempFiles(
    files: { name: string; content: string | Buffer }[],
): Promise<{ dir: string; paths: string[] }> {
    const dir = await mkdtemp(join(tmpdir(), 'bolter-zip-test-'));
    const paths: string[] = [];
    for (const f of files) {
        const p = join(dir, f.name);
        await writeFile(p, f.content);
        paths.push(p);
    }
    return { dir, paths };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
    for (const dir of tempDirs) {
        try {
            await rm(dir, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    }
    tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// generateZipFilename
// ---------------------------------------------------------------------------

describe('generateZipFilename', () => {
    test('single file returns filename.zip', () => {
        expect(generateZipFilename(['/tmp/report.pdf'])).toBe('report.pdf.zip');
    });

    test('two files returns stems joined with dash', () => {
        expect(generateZipFilename(['/tmp/a.txt', '/tmp/b.txt'])).toBe('a-b.zip');
    });

    test('three files returns stems joined with dash', () => {
        expect(generateZipFilename(['/tmp/a.txt', '/tmp/b.txt', '/tmp/c.txt'])).toBe('a-b-c.zip');
    });

    test('four or more files returns N-files.zip', () => {
        expect(generateZipFilename(['/tmp/a.txt', '/tmp/b.txt', '/tmp/c.txt', '/tmp/d.txt'])).toBe(
            '4-files.zip',
        );
    });

    test('five files returns 5-files.zip', () => {
        expect(
            generateZipFilename([
                '/tmp/a.txt',
                '/tmp/b.txt',
                '/tmp/c.txt',
                '/tmp/d.txt',
                '/tmp/e.txt',
            ]),
        ).toBe('5-files.zip');
    });

    test('long filenames are truncated to 40 chars', () => {
        const longName1 = 'a'.repeat(25);
        const longName2 = 'b'.repeat(25);
        const result = generateZipFilename([`/tmp/${longName1}.txt`, `/tmp/${longName2}.txt`]);
        // joined stem is "aaa...aaa-bbb...bbb" = 51 chars, truncated to 40
        expect(result.endsWith('.zip')).toBe(true);
        const stem = result.replace('.zip', '');
        expect(stem.length).toBeLessThanOrEqual(40);
    });

    test('empty array returns archive.zip', () => {
        expect(generateZipFilename([])).toBe('archive.zip');
    });
});

// ---------------------------------------------------------------------------
// zipFiles
// ---------------------------------------------------------------------------

describe('zipFiles', () => {
    test('zips two files and output exists with nonzero size', async () => {
        const { dir, paths } = await makeTempFiles([
            { name: 'hello.txt', content: 'Hello, world!' },
            { name: 'data.bin', content: Buffer.from([0x00, 0x01, 0x02, 0x03]) },
        ]);
        tempDirs.push(dir);

        const result = await zipFiles(paths);
        expect(result.size).toBeGreaterThan(0);
        expect(result.filename).toBe('hello-data.zip');

        // Verify the file actually exists on disk
        const file = Bun.file(result.path);
        expect(await file.exists()).toBe(true);

        // Clean up the zip
        await cleanupTempFile(result.path);
    });

    test('zipped archive is a valid zip (starts with PK magic bytes)', async () => {
        const { dir, paths } = await makeTempFiles([
            { name: 'a.txt', content: 'file A' },
            { name: 'b.txt', content: 'file B' },
        ]);
        tempDirs.push(dir);

        const result = await zipFiles(paths);
        const bytes = await Bun.file(result.path).arrayBuffer();
        const view = new Uint8Array(bytes);

        // ZIP files start with PK\x03\x04
        expect(view[0]).toBe(0x50); // P
        expect(view[1]).toBe(0x4b); // K
        expect(view[2]).toBe(0x03);
        expect(view[3]).toBe(0x04);

        await cleanupTempFile(result.path);
    });

    test('progress callback fires and reaches 100%', async () => {
        // Create files large enough that progress events fire
        const bigContent = Buffer.alloc(256 * 1024, 'x'); // 256 KB
        const { dir, paths } = await makeTempFiles([
            { name: 'big1.txt', content: bigContent },
            { name: 'big2.txt', content: bigContent },
        ]);
        tempDirs.push(dir);

        const progressValues: number[] = [];
        const result = await zipFiles(paths, (percent) => {
            progressValues.push(percent);
        });

        expect(progressValues.length).toBeGreaterThan(0);
        // The last progress value should be 100
        expect(progressValues[progressValues.length - 1]).toBe(100);

        await cleanupTempFile(result.path);
    });

    test('output path is inside the OS tmpdir', async () => {
        const { dir, paths } = await makeTempFiles([{ name: 'test.txt', content: 'test content' }]);
        tempDirs.push(dir);

        const result = await zipFiles(paths);
        expect(result.path.startsWith(tmpdir())).toBe(true);

        await cleanupTempFile(result.path);
    });

    test('single file zip uses correct filename', async () => {
        const { dir, paths } = await makeTempFiles([
            { name: 'only.csv', content: 'col1,col2\na,b' },
        ]);
        tempDirs.push(dir);

        const result = await zipFiles(paths);
        expect(result.filename).toBe('only.csv.zip');

        await cleanupTempFile(result.path);
    });
});

// ---------------------------------------------------------------------------
// cleanupTempFile
// ---------------------------------------------------------------------------

describe('cleanupTempFile', () => {
    test('removes an existing file', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'bolter-cleanup-test-'));
        tempDirs.push(dir);

        const filePath = join(dir, 'to-delete.tmp');
        await writeFile(filePath, 'temporary');

        // Verify it exists
        expect(await Bun.file(filePath).exists()).toBe(true);

        await cleanupTempFile(filePath);

        // Verify it's gone
        expect(await Bun.file(filePath).exists()).toBe(false);
    });

    test('does not throw on a missing file', async () => {
        // Should not reject — the function swallows ENOENT
        await expect(
            cleanupTempFile('/tmp/nonexistent-bolter-test-file-999.zip'),
        ).resolves.toBeUndefined();
    });
});
