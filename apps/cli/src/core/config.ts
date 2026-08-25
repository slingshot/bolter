/**
 * Configuration, and the order it resolves in.
 *
 * Precedence is the whole point: **flag > environment > project file > user
 * file > built-in**. Anything looser and a user cannot tell why a value took
 * effect; anything implicit and a CI job silently picks up a developer's
 * personal defaults.
 *
 * Reading is deliberately forgiving in one direction only: a missing file is
 * fine, a malformed one is an error. Silently ignoring a config file someone
 * edited is worse than refusing to start.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SendfmError } from './errors';
import { configFile } from './paths';

export const DEFAULT_INSTANCE = 'https://send.fm';

const instanceAlias = z.object({
    url: z.string().url(),
    description: z.string().optional(),
});

export const configSchema = z
    .object({
        /** Instance used when no --instance flag or alias is given. */
        instance: z.string().min(1).optional(),
        /** Named shortcuts: `sendfm up -i work` resolves through this map. */
        instances: z.record(z.string(), instanceAlias).optional(),
        defaults: z
            .object({
                expire: z.string().optional(),
                downloads: z.number().int().positive().optional(),
                encrypt: z.boolean().optional(),
                compress: z.boolean().optional(),
                concurrency: z.number().int().positive().max(64).optional(),
            })
            .optional(),
        ui: z
            .object({
                tui: z.enum(['auto', 'always', 'never']).optional(),
                color: z.enum(['auto', 'always', 'never']).optional(),
            })
            .optional(),
        /** Store file secrets in the state DB so `ls` can reprint working links. */
        storeSecrets: z.boolean().optional(),
        updateCheck: z.boolean().optional(),
    })
    .strict();

export type SendfmConfig = z.infer<typeof configSchema>;

export interface LoadedConfig {
    values: SendfmConfig;
    /** Files that actually contributed, nearest-wins last. For `config` output. */
    sources: string[];
}

const PROJECT_FILENAMES = ['.sendfmrc.json', '.sendfmrc', '.config/sendfm.json'];

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new SendfmError('USAGE', `Could not read config at ${path}`, {
            cause: error,
            hint: 'Fix the JSON syntax, or delete the file to fall back to defaults.',
        });
    }
}

function parse(path: string, raw: unknown): SendfmConfig {
    const result = configSchema.safeParse(raw);
    if (!result.success) {
        const first = result.error.issues[0];
        throw new SendfmError(
            'USAGE',
            `Invalid config at ${path}: ${first.path.join('.') || '(root)'} — ${first.message}`,
            { hint: 'Run `sendfm config path` to locate the file.' },
        );
    }
    return result.data;
}

/** Later entries override earlier ones, one level deep per section. */
function merge(base: SendfmConfig, next: SendfmConfig): SendfmConfig {
    return {
        ...base,
        ...next,
        instances: { ...base.instances, ...next.instances },
        defaults: { ...base.defaults, ...next.defaults },
        ui: { ...base.ui, ...next.ui },
    };
}

export interface LoadConfigOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /** Explicit --config path. Its absence is an error; a default's is not. */
    explicitPath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const sources: string[] = [];
    let values: SendfmConfig = {};

    if (options.explicitPath) {
        if (!existsSync(options.explicitPath)) {
            throw new SendfmError(
                'USAGE',
                `No config file at ${options.explicitPath}`,
                // Asked for explicitly, so falling back would hide the typo.
                { hint: 'Check the --config path.' },
            );
        }
        values = parse(options.explicitPath, readJson(options.explicitPath));
        return { values, sources: [options.explicitPath] };
    }

    const userPath = configFile(env);
    if (existsSync(userPath)) {
        values = merge(values, parse(userPath, readJson(userPath)));
        sources.push(userPath);
    }

    for (const name of PROJECT_FILENAMES) {
        const path = join(cwd, name);
        if (existsSync(path)) {
            values = merge(values, parse(path, readJson(path)));
            sources.push(path);
        }
    }

    return { values, sources };
}

/**
 * Resolve the instance origin for this invocation.
 *
 * An alias is looked up before a URL is assumed, so `-i work` works and a typo
 * like `-i sen.fm` fails as an unreachable host rather than being silently
 * treated as an alias that does not exist.
 */
/**
 * Reduce a URL a person actually typed to the root discovery probes hang off.
 *
 * People know the *frontend* URL because they are holding a share link, so
 * pasting the whole link into `-i` is the obvious move. Probed as given it
 * becomes `/download/<id>/instance.json`, which a single-page app answers with
 * its own HTML and a 200 — a confusing failure for an entirely reasonable
 * input.
 *
 * Only a share-link path is removed, not every path. Discovery probes
 * `${base}/instance.json`, so an instance mounted at `https://example.com/bolter`
 * works today; stripping unconditionally would break that deployment to fix
 * this one.
 */
function instanceRootOf(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return url;
    }
    if (/^\/download\/[^/]+\/?$/.test(parsed.pathname)) {
        return parsed.origin;
    }
    // A fragment or query is never part of an instance root, and a trailing
    // slash would double up when a probe path is appended.
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}`;
}

export function resolveInstanceOrigin(opts: {
    flag?: string;
    config: SendfmConfig;
    env?: NodeJS.ProcessEnv;
}): string {
    const env = opts.env ?? process.env;
    const requested = opts.flag || env.SENDFM_INSTANCE || opts.config.instance;
    if (!requested) {
        return DEFAULT_INSTANCE;
    }
    const alias = opts.config.instances?.[requested];
    if (alias) {
        return alias.url;
    }
    if (/^https?:\/\//i.test(requested)) {
        return instanceRootOf(requested);
    }
    // Bare hostnames are common enough to be worth accepting, but only over
    // https — silently downgrading someone's transfer to http is not a
    // convenience worth having.
    if (/^[a-z0-9.-]+(:\d+)?$/i.test(requested)) {
        return `https://${requested}`;
    }
    throw new SendfmError('USAGE', `Unknown instance "${requested}"`, {
        hint: 'Pass a full URL, or add an alias with `sendfm config set instances.<name>.url`.',
    });
}
