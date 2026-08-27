/**
 * sendfm — end-to-end encrypted file transfer from the command line.
 *
 * Everything that talks to a Bolter instance lives in `@bolter/protocol`, so
 * this binary and the web app cannot disagree about part boundaries, record
 * counters or metadata encoding. What is here is the part a browser cannot do:
 * random access to a source file, durable local state, and a terminal.
 */

import pkg from '../package.json' with { type: 'json' };
import { createCLI } from './cli';
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

// No plugins, and no agent detection. The AI-detect plugin was here to
// suppress prompts nobody can answer and to hint that --json exists; this CLI
// prompts for nothing and documents --json on every command, so it was paying
// for a dependency to do neither.
//
// Completions are generated from the command table — see
// `src/cli/completions.ts`. This is also what retires the v0.1.0 bug where
// `completionsPlugin` derived the command name from `process.cwd()`, so a
// shipped binary emitted completions for whatever directory the user was
// standing in. The name below is the only one the generator can use.
// `__tests__/completions.test.ts` still runs the CLI from a temp directory to
// keep it that way.
const cli = createCLI({
    name: 'sendfm',
    version: pkg.version,
    description: pkg.description,
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
