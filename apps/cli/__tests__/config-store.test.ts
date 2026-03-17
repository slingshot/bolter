import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
    CONFIG_PATH,
    loadConfig,
    resetConfig,
    resolveFrontend,
    resolveServer,
    saveConfig,
} from '../lib/config-store';

const DEFAULTS = {
    server: 'https://api.send.fm',
    frontend: 'https://send.fm',
};

let originalConfigContent: string | null = null;

beforeAll(async () => {
    // Save the original config file content if it exists
    try {
        const file = Bun.file(CONFIG_PATH);
        if (await file.exists()) {
            originalConfigContent = await file.text();
        }
    } catch {
        originalConfigContent = null;
    }
});

afterAll(async () => {
    // Restore original config
    if (originalConfigContent === null) {
        // Remove the config file if it didn't exist before tests
        try {
            const { unlink } = await import('node:fs/promises');
            await unlink(CONFIG_PATH);
        } catch {
            // Ignore if file doesn't exist
        }
    } else {
        await Bun.write(CONFIG_PATH, originalConfigContent);
    }
    // Clean up env var if set during tests
    delete process.env.BOLTER_SERVER;
});

describe('loadConfig', () => {
    test('returns defaults when config file has been reset', async () => {
        // Reset to ensure clean state (writes defaults to disk)
        await resetConfig();
        // Now delete the file to simulate no config
        try {
            const { unlink } = await import('node:fs/promises');
            await unlink(CONFIG_PATH);
        } catch {
            // ignore
        }
        const config = await loadConfig();
        expect(config).toEqual(DEFAULTS);
    });

    test('returns defaults with correct server URL', async () => {
        try {
            const { unlink } = await import('node:fs/promises');
            await unlink(CONFIG_PATH);
        } catch {
            // ignore
        }
        const config = await loadConfig();
        expect(config.server).toBe('https://api.send.fm');
    });

    test('returns defaults with correct frontend URL', async () => {
        try {
            const { unlink } = await import('node:fs/promises');
            await unlink(CONFIG_PATH);
        } catch {
            // ignore
        }
        const config = await loadConfig();
        expect(config.frontend).toBe('https://send.fm');
    });
});

describe('saveConfig', () => {
    test('persists a custom server and reads it back', async () => {
        await saveConfig({ server: 'https://custom.example.com' });
        const config = await loadConfig();
        expect(config.server).toBe('https://custom.example.com');
        expect(config.frontend).toBe(DEFAULTS.frontend);
    });

    test('persists a custom frontend and reads it back', async () => {
        await resetConfig();
        await saveConfig({ frontend: 'https://custom-frontend.example.com' });
        const config = await loadConfig();
        expect(config.frontend).toBe('https://custom-frontend.example.com');
        expect(config.server).toBe(DEFAULTS.server);
    });

    test('merges partial updates with existing config', async () => {
        await resetConfig();
        await saveConfig({ server: 'https://first.example.com' });
        await saveConfig({ frontend: 'https://second.example.com' });
        const config = await loadConfig();
        expect(config.server).toBe('https://first.example.com');
        expect(config.frontend).toBe('https://second.example.com');
    });

    test('writes valid JSON to disk', async () => {
        await saveConfig({ server: 'https://json-test.example.com' });
        const file = Bun.file(CONFIG_PATH);
        const text = await file.text();
        const parsed = JSON.parse(text);
        expect(parsed.server).toBe('https://json-test.example.com');
    });
});

describe('resetConfig', () => {
    test('restores default values', async () => {
        await saveConfig({ server: 'https://custom.example.com', frontend: 'https://custom.fm' });
        const reset = await resetConfig();
        expect(reset).toEqual(DEFAULTS);
    });

    test('loadConfig returns defaults after reset', async () => {
        await saveConfig({ server: 'https://will-be-reset.example.com' });
        await resetConfig();
        const config = await loadConfig();
        expect(config).toEqual(DEFAULTS);
    });
});

describe('resolveServer', () => {
    test('returns config value when no flag and no env var', async () => {
        delete process.env.BOLTER_SERVER;
        await resetConfig();
        const server = await resolveServer();
        expect(server).toBe('https://api.send.fm');
    });

    test('returns flag value when provided (highest priority)', async () => {
        process.env.BOLTER_SERVER = 'https://env.example.com';
        await saveConfig({ server: 'https://config.example.com' });
        const server = await resolveServer('https://flag.example.com');
        expect(server).toBe('https://flag.example.com');
        delete process.env.BOLTER_SERVER;
    });

    test('respects BOLTER_SERVER env var over config', async () => {
        delete process.env.BOLTER_SERVER;
        await saveConfig({ server: 'https://config.example.com' });
        process.env.BOLTER_SERVER = 'https://env.example.com';
        const server = await resolveServer();
        expect(server).toBe('https://env.example.com');
        delete process.env.BOLTER_SERVER;
    });

    test('strips trailing slashes from flag value', async () => {
        const server = await resolveServer('https://flag.example.com///');
        expect(server).toBe('https://flag.example.com');
    });

    test('strips trailing slashes from env var', async () => {
        process.env.BOLTER_SERVER = 'https://env.example.com//';
        const server = await resolveServer();
        expect(server).toBe('https://env.example.com');
        delete process.env.BOLTER_SERVER;
    });

    test('returns saved config server when custom value was persisted', async () => {
        delete process.env.BOLTER_SERVER;
        await saveConfig({ server: 'https://saved.example.com' });
        const server = await resolveServer();
        expect(server).toBe('https://saved.example.com');
    });
});

describe('resolveFrontend', () => {
    test('returns default frontend when no flag provided', async () => {
        await resetConfig();
        const frontend = await resolveFrontend();
        expect(frontend).toBe('https://send.fm');
    });

    test('returns flag value when provided', async () => {
        const frontend = await resolveFrontend('https://custom-fe.example.com');
        expect(frontend).toBe('https://custom-fe.example.com');
    });

    test('strips trailing slashes from flag value', async () => {
        const frontend = await resolveFrontend('https://custom-fe.example.com///');
        expect(frontend).toBe('https://custom-fe.example.com');
    });
});
