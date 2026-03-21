#!/usr/bin/env node

import { Command } from 'commander';
import { compileCommand } from './commands/compile.js';
import { initCommand } from './commands/init.js';
import { inspectCommand } from './commands/inspect.js';
import { resolveCommand } from './commands/resolve.js';
import { serveCommand } from './commands/serve.js';
import { doctorCommand } from './commands/doctor.js';

const program = new Command();

program
  .name('smallchat')
  .description('A message-passing tool compiler inspired by the Smalltalk/Objective-C runtime')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(compileCommand);
program.addCommand(inspectCommand);
program.addCommand(resolveCommand);
program.addCommand(serveCommand);
program.addCommand(doctorCommand);

program.parse();
