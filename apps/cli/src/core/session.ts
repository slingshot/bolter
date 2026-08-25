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
    /**
     * The environment this invocation resolved against.
     *
     * Threaded rather than read from `process.env` at each use, so state and
     * config directories can be redirected per invocation — which tests need
     * and `SENDFM_STATE_DIR` users get for free.
     */
    readonly env: NodeJS.ProcessEnv;
    readonly config: SendfmConfig;
    readonly configSources: string[];
    readonly instanceOrigin: string;
    /**
     * True when `-i` was passed on this invocation.
     *
     * Distinct from "an origin was resolved", which is always true. A share
     * link names the instance holding the file, and that outranks a configured
     * default — but not a flag the person typed just now.
     */
    readonly instanceExplicit: boolean;
    readonly verbose: boolean;
    readonly warnings: EnvelopeWarning[];
    warn(code: string, message: string): void;
    /** Resolve the instance once per invocation, then reuse it. */
    instance(): Promise<InstanceDocument>;
    client(): Promise<BolterClient>;
    /** The same, for an origin a link named rather than the configured one. */
    instanceFor(origin: string): Promise<InstanceDocument>;
    clientFor(origin: string): Promise<BolterClient>;
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
    // Keyed by origin: one invocation can legitimately talk to two instances —
    // `get` reading a link from elsewhere, `resume` finishing an older send.
    const instances = new Map<string, InstanceDocument>();
    const clients = new Map<string, BolterClient>();

    const session: Session = {
        output,
        env,
        config: values,
        configSources: sources,
        instanceOrigin,
        instanceExplicit: Boolean(flags.instance),
        verbose: flags.verbose ?? false,
        warnings,
        signal: options.signal ?? new AbortController().signal,

        warn(code, message) {
            warnings.push({ code, message });
            output.warn(message);
        },

        instance() {
            return session.instanceFor(instanceOrigin);
        },

        client() {
            return session.clientFor(instanceOrigin);
        },

        async instanceFor(origin) {
            const already = instances.get(origin);
            if (already) {
                return already;
            }
            let discovered: Awaited<ReturnType<typeof discoverInstance>>;
            try {
                discovered = await discoverInstance(origin);
            } catch (error) {
                const found = error instanceof InstanceNotFoundError ? error : null;
                const servedNonJson = found?.servedNonJson ?? false;
                const intercepted = found?.interceptedBy ?? null;
                throw new SendfmError(
                    'INSTANCE_UNREACHABLE',
                    found ? found.message : `Could not reach a Bolter instance at ${origin}`,
                    {
                        cause: error,
                        // Interception is a door, not a dead end: the same
                        // request may well succeed once it is opened.
                        retryable: !servedNonJson,
                        hint: intercepted
                            ? 'Open the protection or sign in, then retry — or pass the API origin with `-i`.'
                            : servedNonJson
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
            instances.set(origin, discovered.instance);
            return discovered.instance;
        },

        async clientFor(origin) {
            const already = clients.get(origin);
            if (already) {
                return already;
            }
            const instance = await session.instanceFor(origin);
            const created = createBolterClient({ baseUrl: instance.api });
            clients.set(origin, created);
            return created;
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
