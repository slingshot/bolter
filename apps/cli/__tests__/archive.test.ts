import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveName, crc32, planArchive } from '../src/transfer/archive';
import { ArchiveSource, suggestArchiveName } from '../src/transfer/source';

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sendfm-zip-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function write(name: string, contents: string | Uint8Array): string {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
    return path;
}

async function collect(source: ArchiveSource, chunkSize: number): Promise<Uint8Array> {
    const out = new Uint8Array(source.plaintextSize);
    let at = 0;
    while (at < source.plaintextSize) {
        const end = Math.min(at + chunkSize, source.plaintextSize);
        for await (const chunk of source.read(at, end)) {
            out.set(chunk, at);
            at += chunk.length;
        }
    }
    return out;
}

describe('crc32', () => {
    it('matches the known vector for "123456789"', () => {
        expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    });

    it('is resumable, so a part boundary mid-file is not a special case', () => {
        const bytes = new TextEncoder().encode('123456789');
        const whole = crc32(bytes);
        const split = crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4)));
        expect(split).toBe(whole);
    });
});

describe('planArchive', () => {
    it('computes the whole layout from names and sizes alone', () => {
        const layout = planArchive([
            { name: 'a.txt', size: 10, path: '/a', mtime: new Date(0) },
            { name: 'b.txt', size: 20, path: '/b', mtime: new Date(0) },
        ]);
        // No content was read, yet every offset is known — which is what makes
        // an archive upload resumable.
        expect(layout.entries[0].headerOffset).toBe(0);
        expect(layout.entries[1].headerOffset).toBe(layout.entries[0].descriptorOffset + 16);
        expect(layout.totalSize).toBeGreaterThan(30);
    });

    it('is deterministic', () => {
        const inputs = [{ name: 'a.txt', size: 10, path: '/a', mtime: new Date(0) }];
        expect(planArchive(inputs).totalSize).toBe(planArchive(inputs).totalSize);
    });

    it('switches to zip64 when an entry exceeds a 32-bit size field', () => {
        const layout = planArchive([
            { name: 'huge.bin', size: 5_000_000_000, path: '/h', mtime: new Date(0) },
        ]);
        expect(layout.zip64).toBe(true);
        expect(layout.entries[0].zip64).toBe(true);
    });
});

describe('archiveName', () => {
    it('strips leading slashes and parent traversal', () => {
        // An archive that unpacks outside its destination is Zip Slip;
        // producing one is as much a bug as accepting one.
        expect(archiveName('/etc/passwd')).toBe('etc/passwd');
        expect(archiveName('../../secrets.txt')).toBe('secrets.txt');
        expect(archiveName('a/./b/../c.txt')).toBe('a/b/c.txt');
    });

    it('normalises Windows separators', () => {
        expect(archiveName('docs\\notes.txt')).toBe('docs/notes.txt');
    });
});

describe('ArchiveSource', () => {
    it('produces an archive real tools accept', async () => {
        write('one.txt', 'hello world');
        write('nested/two.bin', new Uint8Array(3000).fill(7));
        const source = await ArchiveSource.open([
            { path: join(root, 'one.txt'), name: 'one.txt' },
            { path: join(root, 'nested/two.bin'), name: 'nested/two.bin' },
        ]);

        const bytes = await collect(source, 64 * 1024);
        expect(bytes.length).toBe(source.plaintextSize);

        const out = join(root, 'out.zip');
        writeFileSync(out, bytes);

        // The real check: `unzip -t` verifies every CRC in the archive.
        const test = Bun.spawnSync(['unzip', '-t', out]);
        expect(test.stdout.toString()).toContain('No errors detected');
        expect(test.exitCode).toBe(0);

        const list = Bun.spawnSync(['unzip', '-l', out]).stdout.toString();
        expect(list).toContain('one.txt');
        expect(list).toContain('nested/two.bin');
    });

    it('round-trips contents through a real extraction', async () => {
        write('data.txt', 'the quick brown fox');
        const source = await ArchiveSource.open([
            { path: join(root, 'data.txt'), name: 'data.txt' },
        ]);
        const out = join(root, 'rt.zip');
        writeFileSync(out, await collect(source, 1024));

        const dest = join(root, 'extracted');
        mkdirSync(dest, { recursive: true });
        expect(Bun.spawnSync(['unzip', '-q', out, '-d', dest]).exitCode).toBe(0);
        expect(await Bun.file(join(dest, 'data.txt')).text()).toBe('the quick brown fox');
    });

    it('is byte-identical however the range is cut', async () => {
        // Part boundaries land wherever the server's part size puts them, so
        // the archive has to be independent of how it is sliced.
        write('a.bin', new Uint8Array(5000).fill(1));
        write('b.bin', new Uint8Array(7000).fill(2));
        const inputs = [
            { path: join(root, 'a.bin'), name: 'a.bin' },
            { path: join(root, 'b.bin'), name: 'b.bin' },
        ];

        const whole = await collect(await ArchiveSource.open(inputs), 1_000_000);
        for (const chunkSize of [37, 512, 4096]) {
            expect(await collect(await ArchiveSource.open(inputs), chunkSize)).toEqual(whole);
        }
    });

    it('produces identical bytes when a range is re-read, as a retry does', async () => {
        write('a.bin', new Uint8Array(9000).fill(3));
        const source = await ArchiveSource.open([{ path: join(root, 'a.bin'), name: 'a.bin' }]);

        const readRange = async (start: number, end: number) => {
            const parts: Uint8Array[] = [];
            for await (const chunk of source.read(start, end)) {
                parts.push(new Uint8Array(chunk));
            }
            return Buffer.concat(parts);
        };

        const first = await readRange(0, 4096);
        // Re-reading must not fold the same bytes into the CRC twice; without
        // a rewindable checkpoint it would, and the archive would be corrupt
        // while the upload reported success.
        const again = await readRange(0, 4096);
        expect(again).toEqual(first);

        const rest = await readRange(4096, source.plaintextSize);
        const out = join(root, 'retry.zip');
        writeFileSync(out, Buffer.concat([first, rest]));
        expect(Bun.spawnSync(['unzip', '-t', out]).exitCode).toBe(0);
    });

    it('refuses a range that does not start at a produced boundary', async () => {
        write('a.bin', new Uint8Array(100).fill(1));
        const source = await ArchiveSource.open([{ path: join(root, 'a.bin'), name: 'a.bin' }]);
        const iterator = source.read(50, 60)[Symbol.asyncIterator]();
        await expect(iterator.next()).rejects.toThrow(/produced boundary/);
    });

    it('detects a file that changed underneath it', async () => {
        write('a.bin', new Uint8Array(5000).fill(1));
        const source = await ArchiveSource.open([{ path: join(root, 'a.bin'), name: 'a.bin' }]);
        writeFileSync(join(root, 'a.bin'), new Uint8Array(10).fill(1));
        const iterator = source.read(0, source.plaintextSize)[Symbol.asyncIterator]();
        // Continuing would upload an archive whose headers describe a file
        // that no longer exists.
        await expect(
            (async () => {
                for (;;) {
                    const next = await iterator.next();
                    if (next.done) {
                        return;
                    }
                }
            })(),
        ).rejects.toThrow(/changed while it was being uploaded/);
    });
});

describe('suggestArchiveName', () => {
    it('uses a meaningful shared prefix', () => {
        expect(
            suggestArchiveName([
                { name: 'report-2026-q1.pdf', size: 1, type: '' },
                { name: 'report-2026-q2.pdf', size: 1, type: '' },
            ]),
        ).toBe('report-2026-q.zip');
    });

    it('falls back to a count when there is no shared prefix', () => {
        expect(
            suggestArchiveName([
                { name: 'alpha.txt', size: 1, type: '' },
                { name: 'beta.txt', size: 1, type: '' },
            ]),
        ).toBe('files-2.zip');
    });
});
