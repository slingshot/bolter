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
import logs from './commands/logs';
import ls from './commands/ls';
import password from './commands/password';
import report from './commands/report';
import resume from './commands/resume';
import rm from './commands/rm';
import set from './commands/set';
import up from './commands/up';
import update from './commands/update';

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
        // `commandName` is mandatory, not decorative: without it the plugin
        // derives the name from `process.cwd()` at runtime rather than from
        // `name` above, so a shipped binary emitted completions for whatever
        // directory the user was standing in — `bolter-monorepo` inside this
        // repo, and plain `cli` anywhere without a package.json. The generated
        // script both registers against that name and shells out to it for
        // candidates, so completion silently did nothing. Shipped broken in
        // v0.1.0; see __tests__/completions.test.ts, which runs the CLI from a
        // temp directory because running it from this package hides the bug.
        completionsPlugin({ commandName: 'sendfm' }),
    ] as const,
});

cli.command(up);
cli.command(get);
cli.command(info);
cli.command(doctor);
cli.command(ls);
cli.command(resume);
cli.command(rm);
cli.command(set);
cli.command(password);
cli.command(config);
cli.command(logs);
cli.command(report);
cli.command(update);

await cli.run();
