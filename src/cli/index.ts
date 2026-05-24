#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileCommand } from './commands/compile.js';
import { initCommand } from './commands/init.js';
import { inspectCommand } from './commands/inspect.js';
import { resolveCommand } from './commands/resolve.js';
import { serveCommand } from './commands/serve.js';
import { doctorCommand } from './commands/doctor.js';
import { docsCommand } from './commands/docs.js';
import { replCommand } from './commands/repl.js';
import { channelCommand } from './commands/channel.js';
import { dreamCommand } from './commands/dream.js';
import { memexCommand } from './commands/memex.js';
import { setupCommand } from './commands/setup.js';
import { appCommand } from './commands/app.js';
import { rtkCommand } from './commands/rtk.js';

function readPackageVersion(): string {
  try {
    // dist/cli/index.js → dist/ → repo root containing package.json
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('smallchat')
  .description('A message-passing tool compiler inspired by the Smalltalk/Objective-C runtime')
  .version(readPackageVersion());

// Enable "Did you mean ...?" suggestions for mistyped commands
program.showSuggestionAfterError(true);

program.addCommand(initCommand);
program.addCommand(compileCommand);
program.addCommand(appCommand);
program.addCommand(inspectCommand);
program.addCommand(resolveCommand);
program.addCommand(serveCommand);
program.addCommand(doctorCommand);
program.addCommand(docsCommand);
program.addCommand(replCommand);
program.addCommand(channelCommand);
program.addCommand(dreamCommand);
program.addCommand(memexCommand);
program.addCommand(setupCommand);
program.addCommand(rtkCommand);

// Add a getting-started guide to the help output
program.addHelpText('after', `
Getting Started
───────────────
  1. Set up your environment (auto-detects your MCP servers):
     $ smallchat setup

  2. Or compile manually from an MCP config file:
     $ smallchat compile --source ~/.mcp.json

  3. Inspect your compiled toolkit:
     $ smallchat inspect tools.toolkit.json

  4. Test dispatch resolution:
     $ smallchat resolve tools.toolkit.json "search for files"

  5. Start a server:
     $ smallchat serve --source tools.toolkit.json

  6. Compile a knowledge base:
     $ smallchat memex compile --schema my-domain.schema.json

  7. Reduce LLM token usage with RTK compression:
     $ smallchat rtk setup
     $ smallchat serve --source tools.toolkit.json --rtk

  Run "smallchat <command> --help" for detailed usage of any command.
  Run "smallchat doctor" to check your system health.
`);

program.parse();
