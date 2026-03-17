/**
 * `bolter config` — view and update CLI configuration
 */

import { defineCommand, option } from '@bunli/core';
import { z } from 'zod';
import { CONFIG_PATH, loadConfig, resetConfig, saveConfig } from '../lib/config-store';

const configCommand = defineCommand({
    name: 'config',
    description: 'View or update CLI configuration',
    options: {
        server: option(z.string().optional(), {
            description: 'Set default server URL',
        }),
        show: option(z.boolean().optional().default(false), {
            description: 'Show current config',
        }),
        reset: option(z.boolean().optional().default(false), {
            description: 'Reset to defaults',
        }),
    },
    handler: async ({ flags }) => {
        if (flags.reset) {
            await resetConfig();
            console.log('Config reset to defaults');
            return;
        }

        if (flags.server) {
            await saveConfig({ server: flags.server });
            console.log(`Server set to ${flags.server}`);
            return;
        }

        // --show or no flags: display current config
        const config = await loadConfig();
        console.log(`Bolter CLI Configuration (${CONFIG_PATH})`);
        console.log(`  server:   ${config.server}`);
        console.log(`  frontend: ${config.frontend}`);
    },
});

export default configCommand;
