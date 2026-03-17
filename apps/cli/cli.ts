/**
 * Bolter CLI — encrypted file sharing from the terminal
 */

import { createCLI } from '@bunli/core';
import configCommand from './commands/config';
import { downloadCommand } from './commands/download';
import { uploadCommand } from './commands/upload';

const cli = await createCLI({
    name: 'bolter',
    version: '1.0.0',
    description: 'Bolter CLI \u2014 encrypted file sharing from the terminal',
});

cli.command(uploadCommand);
cli.command(downloadCommand);
cli.command(configCommand);

await cli.run();
