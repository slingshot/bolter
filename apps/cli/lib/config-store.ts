/**
 * Persistent configuration stored at ~/.bolter/config.json
 *
 * Resolution order for server URL:
 *   1. --server flag (per-command)
 *   2. BOLTER_SERVER env var
 *   3. config.json value
 *   4. Default: https://api.send.fm
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const BOLTER_DIR = join(homedir(), '.bolter');
const CONFIG_PATH = join(BOLTER_DIR, 'config.json');
const DEFAULT_SERVER = 'https://api.send.fm';
const DEFAULT_FRONTEND = 'https://send.fm';

export interface BolterConfig {
    server: string;
    frontend: string;
}

const DEFAULTS: BolterConfig = {
    server: DEFAULT_SERVER,
    frontend: DEFAULT_FRONTEND,
};

async function ensureDir(): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(BOLTER_DIR, { recursive: true });
}

/**
 * Read config from disk, returning defaults for missing keys
 */
export async function loadConfig(): Promise<BolterConfig> {
    try {
        const file = Bun.file(CONFIG_PATH);
        if (await file.exists()) {
            const raw = await file.json();
            return { ...DEFAULTS, ...raw };
        }
    } catch {
        // Corrupt or unreadable — return defaults
    }
    return { ...DEFAULTS };
}

/**
 * Write config to disk (merges with existing)
 */
export async function saveConfig(updates: Partial<BolterConfig>): Promise<BolterConfig> {
    await ensureDir();
    const current = await loadConfig();
    const merged = { ...current, ...updates };
    await Bun.write(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
}

/**
 * Reset config to defaults
 */
export async function resetConfig(): Promise<BolterConfig> {
    await ensureDir();
    await Bun.write(CONFIG_PATH, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
    return { ...DEFAULTS };
}

/**
 * Resolve the effective server URL considering all sources
 */
export async function resolveServer(flagValue?: string): Promise<string> {
    if (flagValue) {
        return flagValue.replace(/\/+$/, '');
    }
    const envValue = process.env.BOLTER_SERVER;
    if (envValue) {
        return envValue.replace(/\/+$/, '');
    }
    const config = await loadConfig();
    return config.server.replace(/\/+$/, '');
}

/**
 * Resolve the frontend URL (for building download links)
 */
export async function resolveFrontend(flagValue?: string): Promise<string> {
    if (flagValue) {
        return flagValue.replace(/\/+$/, '');
    }
    const config = await loadConfig();
    return config.frontend.replace(/\/+$/, '');
}

export { BOLTER_DIR, CONFIG_PATH };
