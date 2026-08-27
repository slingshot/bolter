/**
 * Shell completion scripts, generated from the command table.
 *
 * Static scripts, not a callback protocol. A protocol-based completer shells
 * out to the binary on every Tab, which means completion is as slow as process
 * startup and stops working entirely if the binary moves or a config file is
 * malformed — while a completion script is exactly the thing you reach for
 * when you are unsure enough to press Tab.
 *
 * The cost is that a script goes stale when commands change. That is a fair
 * trade for a CLI whose command set changes a few times a year, and the
 * generator lives next to the table it reads, so regenerating is one command.
 */

import { type CommandDef, isFlag, type OptionDef } from './define';

export type ShellType = 'bash' | 'zsh' | 'fish';

export const SHELLS: readonly ShellType[] = ['bash', 'zsh', 'fish'] as const;

export function isShellType(value: string): value is ShellType {
    return (SHELLS as readonly string[]).includes(value);
}

/** Single-quote for POSIX-ish shells: end the quote, escape, reopen. */
function sq(text: string): string {
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** One line of prose, with the characters that break a completion spec gone. */
function oneLine(text: string | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Whether `--no-<flag>` is worth offering.
 *
 * Every flag *accepts* its negated form, but only a flag that is already on
 * has anything to turn off — suggesting `--no-json` next to `--json` doubles
 * the list while saying nothing. Asking the schema what it does with no input
 * is how the default is read, since it is Zod's to know.
 */
function defaultsOn(def: OptionDef): boolean {
    const result = def.schema.safeParse(undefined);
    return result.success && result.data === true;
}

function flagNames(command: CommandDef): string[] {
    const names: string[] = [];
    for (const [name, def] of Object.entries(command.options ?? {})) {
        names.push(`--${name}`);
        if (isFlag(def) && defaultsOn(def)) {
            names.push(`--no-${name}`);
        }
        if (def.short) {
            names.push(`-${def.short}`);
        }
    }
    return names;
}

function bash(cliName: string, commands: CommandDef[]): string {
    const names = commands.flatMap((c) => [c.name, ...(c.alias ?? [])]);
    const cases = commands
        .flatMap((c) => [c.name, ...(c.alias ?? [])].map((n) => [n, c] as const))
        .map(([name, command]) => `        ${name}) opts=${sq(flagNames(command).join(' '))} ;;`)
        .join('\n');

    return `# bash completion for ${cliName}
# Install:  ${cliName} completions bash > /etc/bash_completion.d/${cliName}
#      or:  ${cliName} completions bash >> ~/.bashrc

_${cliName}() {
    local cur cmd opts i
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"

    # The first word that is not a flag is the command.
    cmd=""
    for (( i = 1; i < COMP_CWORD; i++ )); do
        case "\${COMP_WORDS[i]}" in
            -*) ;;
            *) cmd="\${COMP_WORDS[i]}"; break ;;
        esac
    done

    if [[ -z "$cmd" ]]; then
        COMPREPLY=( $(compgen -W ${sq(names.join(' '))} -- "$cur") )
        return 0
    fi

    opts=""
    case "$cmd" in
${cases}
    esac

    if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    else
        # Most positionals here are share links or paths; offering files is
        # the only guess worth making, and it is easy to ignore.
        COMPREPLY=( $(compgen -f -- "$cur") )
    fi
    return 0
}

complete -F _${cliName} ${cliName}
`;
}

function zsh(cliName: string, commands: CommandDef[]): string {
    // `_describe` splits on the first colon, so a colon inside a description
    // would silently truncate it.
    const describe = commands
        .map((c) => `        ${sq(`${c.name}:${oneLine(c.description).replace(/:/g, '\\:')}`)}`)
        .join('\n');

    const cases = commands
        .flatMap((c) => [c.name, ...(c.alias ?? [])].map((n) => [n, c] as const))
        .map(([name, command]) => {
            const args = Object.entries(command.options ?? {})
                .map(([flag, def]) => {
                    const description = oneLine(def.description).replace(/[[\]:]/g, '');
                    const takes = isFlag(def) ? '' : ':value:';
                    const long = `--${flag}[${description}]${takes}`;
                    return def.short
                        ? `                ${sq(`-${def.short}[${description}]${takes}`)} \\\n                ${sq(long)}`
                        : `                ${sq(long)}`;
                })
                .join(' \\\n');
            return `        ${name})\n            _arguments \\\n${args} \\\n                '*:file:_files'\n            ;;`;
        })
        .join('\n');

    return `#compdef ${cliName}
# zsh completion for ${cliName}
# Install:  ${cliName} completions zsh > "\${fpath[1]}/_${cliName}"

_${cliName}() {
    local -a commands
    commands=(
${describe}
    )

    _arguments -C '1: :->command' '*:: :->args'

    case "$state" in
        command)
            _describe -t commands 'command' commands
            ;;
        args)
            case "$words[1]" in
${cases}
            esac
            ;;
    esac
}

_${cliName} "$@"
`;
}

function fish(cliName: string, commands: CommandDef[]): string {
    const lines = [
        `# fish completion for ${cliName}`,
        `# Install:  ${cliName} completions fish > ~/.config/fish/completions/${cliName}.fish`,
        '',
        `complete -c ${cliName} -f`,
        '',
    ];
    for (const command of commands) {
        const description = oneLine(command.description);
        for (const name of [command.name, ...(command.alias ?? [])]) {
            lines.push(
                `complete -c ${cliName} -n __fish_use_subcommand -a ${name} -d ${sq(description)}`,
            );
        }
    }
    lines.push('');
    for (const command of commands) {
        const seen = [command.name, ...(command.alias ?? [])].join(' ');
        for (const [flag, def] of Object.entries(command.options ?? {})) {
            const parts = [
                `complete -c ${cliName}`,
                `-n ${sq(`__fish_seen_subcommand_from ${seen}`)}`,
                def.short ? `-s ${def.short}` : '',
                `-l ${flag}`,
                isFlag(def) ? '' : '-r',
                `-d ${sq(oneLine(def.description))}`,
            ].filter(Boolean);
            lines.push(parts.join(' '));
        }
    }
    return `${lines.join('\n')}\n`;
}

export function renderCompletions(
    shell: ShellType,
    cliName: string,
    commands: CommandDef[],
): string {
    switch (shell) {
        case 'bash':
            return bash(cliName, commands);
        case 'zsh':
            return zsh(cliName, commands);
        case 'fish':
            return fish(cliName, commands);
    }
}
