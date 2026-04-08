#!/usr/bin/env node

import { Command } from 'commander';
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

const program = new Command();

program
  .name('smallchat')
  .description('A message-passing tool compiler inspired by the Smalltalk/Objective-C runtime')
  .version('0.1.0');

// Enable "Did you mean ...?" suggestions for mistyped commands
program.showSuggestionAfterError(true);

program.addCommand(initCommand);
program.addCommand(compileCommand);
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

  Run "smallchat <command> --help" for detailed usage of any command.
  Run "smallchat doctor" to check your system health.
`);

program.parse();
