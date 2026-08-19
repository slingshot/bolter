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
 * Blank out everything that is prose rather than code: comments, and the
 * contents of string and template literals. Only code is constrained — this
 * package's comments legitimately discuss the browser, and its error messages
 * legitimately contain words like "document".
 *
 * Interpolations inside template literals are kept, because `${window.x}` is
 * code and would otherwise slip through.
 */
export function stripNonCode(src: string): string {
    let out = '';
    let i = 0;
    // Depth of `${ }` nesting we are currently inside, per open template.
    const templateStack: number[] = [];

    const isEscaped = () => {
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && src[j] === '\\'; j--) {
            backslashes++;
        }
        return backslashes % 2 === 1;
    };

    while (i < src.length) {
        const two = src.slice(i, i + 2);

        if (two === '//') {
            while (i < src.length && src[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (two === '/*') {
            while (i < src.length && src.slice(i, i + 2) !== '*/') {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            out += '  ';
            i += 2;
            continue;
        }
        if (src[i] === "'" || src[i] === '"') {
            const quote = src[i];
            out += ' ';
            i++;
            while (i < src.length && !(src[i] === quote && !isEscaped())) {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            out += ' ';
            i++;
            continue;
        }
        if (src[i] === '`') {
            out += ' ';
            i++;
            templateStack.push(0);
            while (i < src.length && templateStack.length > 0) {
                if (src.slice(i, i + 2) === '${') {
                    // Interpolation: emit it as code.
                    out += '  ';
                    i += 2;
                    let depth = 1;
                    while (i < src.length && depth > 0) {
                        if (src[i] === '{') {
                            depth++;
                        } else if (src[i] === '}') {
                            depth--;
                            if (depth === 0) {
                                break;
                            }
                        }
                        out += src[i];
                        i++;
                    }
                    out += ' ';
                    i++;
                    continue;
                }
                if (src[i] === '`' && !isEscaped()) {
                    templateStack.pop();
                    out += ' ';
                    i++;
                    continue;
                }
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            continue;
        }
        out += src[i];
        i++;
    }
    return out;
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
        const code = stripNonCode(readFileSync(file, 'utf8'));
        for (const pattern of FORBIDDEN) {
            expect(code).not.toMatch(pattern);
        }
    });

    it('catches a real violation and ignores prose', () => {
        expect(stripNonCode('const a = window.location;')).toMatch(/\bwindow\b/);
        expect(stripNonCode('// a comment about window\nconst a = 1;')).not.toMatch(/\bwindow\b/);
        expect(stripNonCode('/* window */ const a = 1;')).not.toMatch(/\bwindow\b/);
        expect(stripNonCode("throw new Error('no document here');")).not.toMatch(/\bdocument\b/);
        expect(stripNonCode('const s = `a document v1`;')).not.toMatch(/\bdocument\b/);
        // An interpolation is code, not prose, and must still be scanned. Written as an
        // escaped template literal so the `${` is data here rather than a real one.
        expect(stripNonCode(`const s = \`x \${window.name} y\`;`)).toMatch(/\bwindow\b/);
        expect(stripNonCode("const s = 'it\\'s fine window';")).not.toMatch(/\bwindow\b/);
    });
});
