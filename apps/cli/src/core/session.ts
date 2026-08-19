/**
 * Per-invocation context, and the one place a command's outcome becomes an
 * exit code.
 *
 * Every command produces a single `CommandResult`: the data a machine reads
 * and a function that renders it for a person. Having both come from one value
 * is what stops `--json` and human output from disagreeing — the alternative,
 * two code paths that each build their own answer, is how a CLI ends up
 * reporting different things to different audiences.
 */

import {
    type BolterClient,
    checkCompatibility,
    createBolterClient,
    discoverInstance,
    type InstanceDocument,
    InstanceNotFoundError,
} from '@bolter/protocol';
import { type EnvelopeWarning, errorEnvelope, successEnvelope } from '../json/envelope';
import { createOutput, type Output } from '../ui/output';
import { loadConfig, resolveInstanceOrigin, type SendfmConfig } from './config';
import { EXIT, SendfmError, toSendfmError } from './errors';

export interface GlobalFlags {
    json?: boolean;
    instance?: string;
    quiet?: boolean;
    verbose?: boolean;
    color?: boolean;
    config?: string;
}

export interface Session {
    readonly output: Output;
    readonly config: SendfmConfig;
    readonly configSources: string[];
    readonly instanceOrigin: string;
    readonly verbose: boolean;
    readonly warnings: EnvelopeWarning[];
    warn(code: string, message: string): void;
    /** Resolve the instance once per invocation, then reuse it. */
    instance(): Promise<InstanceDocument>;
    client(): Promise<BolterClient>;
    signal: AbortSignal;
}

export interface CommandResult<T> {
    data: T;
    /** Human rendering. Not called in --json mode. */
    render(output: Output): void;
    /**
     * Exit code to use despite the command having produced a result.
     *
     * `doctor` needs this: a failed check is a finding, not a crash. The
     * findings must still be reported — in full, on the right stream, inside a
     * valid envelope — and only then does the process exit non-zero. Throwing
     * instead would replace the answer with an error message.
     */
    exitCode?: number;
}

export interface RunOptions {
    name: string;
    flags: GlobalFlags;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    /** Injectable for tests; defaults to the real process streams. */
    write?: (stream: 'out' | 'err', text: string) => void;
    exit?: (code: number) => void;
}

export function createSession(options: RunOptions): Session {
    const env = options.env ?? process.env;
    const flags = options.flags;
    const json = flags.json ?? env.SENDFM_JSON === '1';

    const output = createOutput({
        json,
        quiet: flags.quiet ?? false,
        noColor: flags.color === false,
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        stderrIsTTY: Boolean(process.stderr.isTTY),
        env,
        write: options.write,
    });

    const { values, sources } = loadConfig({ env, explicitPath: flags.config });
    const instanceOrigin = resolveInstanceOrigin({ flag: flags.instance, config: values, env });

    const warnings: EnvelopeWarning[] = [];
    let cached: InstanceDocument | undefined;
    let client: BolterClient | undefined;

    const session: Session = {
        output,
        config: values,
        configSources: sources,
        instanceOrigin,
        verbose: flags.verbose ?? false,
        warnings,
        signal: options.signal ?? new AbortController().signal,

        warn(code, message) {
            warnings.push({ code, message });
            output.warn(message);
        },

        async instance() {
            if (cached) {
                return cached;
            }
            let discovered: Awaited<ReturnType<typeof discoverInstance>>;
            try {
                discovered = await discoverInstance(instanceOrigin);
            } catch (error) {
                const servedNonJson = error instanceof InstanceNotFoundError && error.servedNonJson;
                throw new SendfmError(
                    'INSTANCE_UNREACHABLE',
                    error instanceof InstanceNotFoundError
                        ? error.message
                        : `Could not reach a Bolter instance at ${instanceOrigin}`,
                    {
                        cause: error,
                        retryable: !servedNonJson,
                        hint: servedNonJson
                            ? 'Try the API origin instead, e.g. `sendfm -i https://api.example doctor`.'
                            : 'Check the URL and your network, then try `sendfm doctor`.',
                    },
                );
            }
            const compatibility = checkCompatibility(discovered.instance);
            if (!compatibility.ok) {
                throw new SendfmError('INSTANCE_INCOMPATIBLE', compatibility.reason, {
                    hint: 'Run `sendfm update` to get a build that speaks this protocol.',
                });
            }
            for (const message of compatibility.warnings) {
                session.warn('INSTANCE_COMPATIBILITY', message);
            }
            cached = discovered.instance;
            return cached;
        },

        async client() {
            if (!client) {
                const instance = await session.instance();
                client = createBolterClient({ baseUrl: instance.api });
            }
            return client;
        },
    };

    return session;
}

/**
 * Run a command body and report it exactly once, on the right stream, with the
 * right exit code.
 *
 * Returns the exit code rather than calling `process.exit` so the whole path is
 * testable; the entry point is what turns it into a process outcome.
 */
export async function runCommand<T>(
    options: RunOptions,
    // Sync or async: `config` never touches the network, and forcing it to be
    // async would only add an await that does nothing.
    body: (session: Session) => CommandResult<T> | Promise<CommandResult<T>>,
): Promise<number> {
    let session: Session | undefined;
    try {
        session = createSession(options);
        const result = await body(session);
        if (session.output.mode === 'json') {
            session.output.emitJson(successEnvelope(options.name, result.data, session.warnings));
        } else {
            result.render(session.output);
        }
        return result.exitCode ?? EXIT.OK;
    } catch (raw) {
        const error = toSendfmError(raw);
        // The session may not exist yet — a bad --config fails while building
        // it — so fall back to a minimal reporter rather than losing the error.
        const output =
            session?.output ??
            createOutput({
                json: options.flags.json ?? false,
                quiet: false,
                noColor: false,
                stdoutIsTTY: Boolean(process.stdout.isTTY),
                stderrIsTTY: Boolean(process.stderr.isTTY),
                env: options.env ?? process.env,
                write: options.write,
            });

        if (output.mode === 'json') {
            output.emitJson(errorEnvelope(options.name, error, session?.warnings ?? []));
        } else {
            output.error(error.message);
            if (error.hint) {
                output.note(output.theme.muted(`  ${error.hint}`));
            }
            if (session?.verbose && error.cause instanceof Error && error.cause.stack) {
                output.note(output.theme.muted(error.cause.stack));
            }
        }
        return error.exitCode;
    }
}
