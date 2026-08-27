/**
 * The completion script must name the binary, not the directory it ran in.
 *
 * `completionsPlugin` resolves the command name from `process.cwd()` at runtime
 * unless it is told one. That is invisible from inside this package — run here,
 * it reads apps/cli/package.json and correctly says `sendfm` — but a shipped
 * binary runs wherever the user happens to be standing. From the monorepo root
 * it emitted `bolter-monorepo`; from a directory with no package.json at all it
 * emitted `cli`. Either way `sendfm completions bash` produced a script that
 * registered completions for a command nobody has and shelled out to that same
 * missing command for candidates, so completion silently did nothing.
 *
 * v0.1.0 shipped with exactly that. These tests therefore run the CLI from a
 * temporary directory: running it from the package would pass with or without
 * the fix, which is the whole reason the bug reached a release.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = join(import.meta.dir, '..', 'src', 'sendfm.ts');
const SHELLS = ['bash', 'zsh', 'fish'] as const;

function completionsFromElsewhere(shell: string): string {
    // A directory with no package.json above it that could lend a name.
    const cwd = mkdtempSync(join(tmpdir(), 'sendfm-completions-'));
    try {
        const result = Bun.spawnSync(['bun', 'run', ENTRY, 'completions', shell], { cwd });
        expect(result.exitCode).toBe(0);
        return result.stdout.toString();
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
}

describe('shell completions', () => {
    for (const shell of SHELLS) {
        test(`${shell} completions name sendfm regardless of the working directory`, () => {
            const script = completionsFromElsewhere(shell);

            expect(script).toContain('sendfm');
            // The two names the bug actually produced.
            expect(script).not.toContain('bolter-monorepo');
            expect(script).not.toMatch(/\b__cli_complete\b/);
        });
    }

    test('bash registers the completion function against sendfm', () => {
        // The registration line is what the shell acts on: a script full of
        // correct candidates still does nothing if it is bound to a command
        // that does not exist.
        expect(completionsFromElsewhere('bash')).toContain('complete -F __sendfm_complete sendfm');
    });
});
