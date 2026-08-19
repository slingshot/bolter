import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The package is consumed by a browser bundle, a dedicated Web Worker and a
 * compiled Bun binary. Anything reaching for a host-specific global works in
 * one of those and throws in the others — at runtime, in whichever environment
 * nobody tested. Scanning the whole source tree makes the constraint
 * structural rather than a rule each new module has to remember.
 *
 * WebCrypto, TextEncoder/Decoder, fetch and the stream types are deliberately
 * absent from the list: Bun implements all of them, so they are portable.
 */
const FORBIDDEN = [
    /\bwindow\b/,
    /\bdocument\b/,
    /\bnavigator\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bindexedDB\b/,
    /\bXMLHttpRequest\b/,
    /\bimport\.meta\.env\b/,
];

/**
 * Comments are prose and may legitimately discuss the browser; only code is
 * constrained. Stripping them first is what keeps this guard from punishing
 * the explanatory comments the rest of this codebase depends on.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const srcDir = join(import.meta.dir, '..', 'src');

const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(full);
        }
        return entry.name.endsWith('.ts') ? [full] : [];
    });

describe('no host-specific globals', () => {
    const files = sources(srcDir);

    it('finds sources to scan', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    it.each(
        files.map((f) => [f.slice(srcDir.length + 1), f] as const),
    )('%s uses no browser-only global', (_name, file) => {
        const code = stripComments(readFileSync(file, 'utf8'));
        for (const pattern of FORBIDDEN) {
            expect(code).not.toMatch(pattern);
        }
    });

    it('would catch a real violation', () => {
        expect(stripComments('const a = window.location;')).toMatch(/\bwindow\b/);
        expect(stripComments('// a comment about window\nconst a = 1;')).not.toMatch(/\bwindow\b/);
    });
});
