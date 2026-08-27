/**
 * The command runner.
 *
 * Replaces `@bunli/core`, whose only remaining job was this: pick a command
 * out of argv, parse its flags, and call its handler. It went because the
 * framework reached much further than that — `@bunli/core` depends on
 * `@bunli/runtime`, which hard-depends on OpenTUI, which is why `bunli build`
 * refused to cross-compile without native packages for a renderer this CLI
 * does not use.
 *
 * Nothing about a command changed to make this possible. `defineCommand` and
 * `option` kept their shapes, so every handler still receives
 * `{ flags, positional }` and every option is still a Zod schema.
 */

import { SendfmError, toSendfmError } from '../core/errors';
import { isShellType, renderCompletions, SHELLS } from './completions';
import type { CommandDef } from './define';
import { helpWidth, renderCommandHelp, renderRootHelp } from './help';
import { parseInvocation } from './parse';

export type { CommandContext, CommandDef, OptionDef, Options } from './define';
export { defineCommand, option } from './define';

export interface CLIOptions {
    name: string;
    version: string;
    description?: string;
}

export interface CLI {
    command(def: CommandDef): void;
    run(argv?: string[]): Promise<void>;
}

const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-V']);

/** Everything up to the first non-flag token, which is the command name. */
function splitInvocation(argv: string[]): { name?: string; rest: string[] } {
    const index = argv.findIndex((arg) => !arg.startsWith('-'));
    if (index === -1) {
        return { rest: argv };
    }
    return { name: argv[index], rest: [...argv.slice(0, index), ...argv.slice(index + 1)] };
}

export function createCLI(cli: CLIOptions): CLI {
    const commands: CommandDef[] = [];
    const find = (name: string) => commands.find((c) => c.name === name || c.alias?.includes(name));

    /**
     * `completions` is defined here rather than in `src/commands/` because it
     * is the one command whose output is a function of the command table
     * itself — it needs the list it would otherwise be an entry in.
     */
    const completionsCommand = (shell: string | undefined): void => {
        if (!shell || !isShellType(shell)) {
            throw new SendfmError('USAGE', shell ? `Unknown shell: ${shell}` : 'Which shell?', {
                hint: `sendfm completions <${SHELLS.join('|')}>`,
            });
        }
        const table = [...commands].sort((a, b) => a.name.localeCompare(b.name));
        process.stdout.write(renderCompletions(shell, cli.name, table));
    };

    return {
        command(def) {
            commands.push(def);
        },

        async run(argv = process.argv.slice(2)) {
            const width = helpWidth(process.stdout.columns);
            const { name, rest } = splitInvocation(argv);

            try {
                if (name === 'completions') {
                    completionsCommand(rest.find((a) => !a.startsWith('-')));
                    return;
                }

                if (name === undefined) {
                    if (argv.some((a) => VERSION_FLAGS.has(a))) {
                        process.stdout.write(`${cli.version}\n`);
                        return;
                    }
                    // Help someone asked for is the result of their command:
                    // stdout, exit 0, so `sendfm --help | less` works. Help
                    // shown because nothing was asked for is a usage failure.
                    const asked = argv.some((a) => HELP_FLAGS.has(a));
                    const text = `${renderRootHelp(cli, commands, width)}\n`;
                    if (asked) {
                        process.stdout.write(text);
                        return;
                    }
                    process.stderr.write(text);
                    process.exitCode = 2;
                    return;
                }

                const command = find(name);
                if (!command) {
                    throw new SendfmError('USAGE', `Unknown command: ${name}`, {
                        hint: `sendfm --help lists the ${commands.length} commands.`,
                    });
                }

                if (rest.some((a) => HELP_FLAGS.has(a))) {
                    process.stdout.write(`${renderCommandHelp(cli.name, command, width)}\n`);
                    return;
                }

                const { flags, positional } = parseInvocation(
                    command.options ?? {},
                    rest,
                    command.name,
                );
                await command.handler({ flags, positional });
            } catch (error) {
                // A usage error is the runner's own failure to understand the
                // invocation, so it reports here. Anything a handler throws has
                // already passed through `runCommand`, which owns rendering and
                // the exit code; this is the backstop for what it re-raises.
                const failure = toSendfmError(error);
                process.stderr.write(`${failure.message}\n`);
                if (failure.hint) {
                    process.stderr.write(`  ${failure.hint}\n`);
                }
                process.exitCode = failure.exitCode;
            }
        },
    };
}
