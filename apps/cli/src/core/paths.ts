/**
 * Where sendfm keeps things, per platform.
 *
 * Config and state are separated on purpose. Config is small, hand-editable
 * and worth syncing between machines; state holds resume journals, cached
 * instance documents and — per the project's decision — file secrets at 0600.
 * Putting those in the same directory invites someone to sync their secrets to
 * a dotfiles repo.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function windowsBase(envVar: string, fallback: string): string {
    return process.env[envVar] || join(homedir(), fallback);
}

/** `~/.config/sendfm`, `~/Library/Application Support/sendfm`, `%APPDATA%\sendfm`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.SENDFM_CONFIG_DIR) {
        return env.SENDFM_CONFIG_DIR;
    }
    if (isWindows) {
        return join(windowsBase('APPDATA', 'AppData/Roaming'), 'sendfm');
    }
    if (isMac) {
        return join(homedir(), 'Library', 'Application Support', 'sendfm');
    }
    return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sendfm');
}

/** `~/.local/state/sendfm`, `~/Library/Application Support/sendfm`, `%LOCALAPPDATA%\sendfm`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.SENDFM_STATE_DIR) {
        return env.SENDFM_STATE_DIR;
    }
    if (isWindows) {
        return join(windowsBase('LOCALAPPDATA', 'AppData/Local'), 'sendfm');
    }
    if (isMac) {
        // macOS has no state/cache split that users expect to see; Application
        // Support is where a CLI's durable data belongs.
        return join(homedir(), 'Library', 'Application Support', 'sendfm');
    }
    return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'sendfm');
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
    return join(configDir(env), 'config.json');
}

export function stateFile(env: NodeJS.ProcessEnv = process.env): string {
    return join(stateDir(env), 'sendfm.sqlite');
}

export function traceDir(env: NodeJS.ProcessEnv = process.env): string {
    return join(stateDir(env), 'traces');
}
