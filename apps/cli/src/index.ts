/**
 * sendfm — end-to-end encrypted file transfer from the command line.
 *
 * Everything that talks to a Bolter instance lives in `@bolter/protocol`, so
 * this binary and the web app cannot disagree about part boundaries, record
 * counters or metadata encoding. What is here is the part a browser cannot do:
 * random access to a source file, durable local state, and a terminal.
 */

import { createCLI } from '@bunli/core';
import { aiAgentPlugin } from '@bunli/plugin-ai-detect';
import { completionsPlugin } from '@bunli/plugin-completions';
import pkg from '../package.json' with { type: 'json' };
import config from './commands/config';
import doctor from './commands/doctor';
import get from './commands/get';
import info from './commands/info';
import { lsCommand, passwordCommand, rmCommand, setCommand } from './commands/manage';
import resume from './commands/resume';
import up from './commands/up';

const cli = await createCLI({
    name: 'sendfm',
    version: pkg.version,
    description: pkg.description,
    plugins: [
        // Used for exactly two things: suppressing prompts nobody can answer,
        // and hinting that --json exists. It deliberately does *not* switch
        // output format — a format that changes based on the environment is
        // worse than a flag someone forgot.
        aiAgentPlugin({}),
        completionsPlugin({}),
    ] as const,
});

cli.command(up);
cli.command(get);
cli.command(info);
cli.command(doctor);
cli.command(lsCommand);
cli.command(resume);
cli.command(rmCommand);
cli.command(setCommand);
cli.command(passwordCommand);
cli.command(config);

await cli.run();
