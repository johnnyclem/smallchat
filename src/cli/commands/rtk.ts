/**
 * smallchat rtk — RTK (Rust Token Killer) integration commands.
 *
 * Subcommands:
 *   rtk setup          Install RTK and configure the Claude Code PreToolUse hook
 *   rtk gain           Show RTK token savings analytics
 *   rtk test <cmd...>  Compare command output with and without RTK
 */

import { Command } from 'commander';
import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { which } from '../../transport/rtk-which.js';

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

export const rtkCommand = new Command('rtk')
  .description('RTK (Rust Token Killer) integration — compress tool outputs to reduce LLM token usage')
  .addHelpText('after', `
RTK reduces LLM token consumption by 60-90% by filtering shell command outputs.
See https://github.com/johnnyclem-rdc/rtk for installation instructions.

Examples:
  smallchat rtk setup                     Install RTK and configure hooks
  smallchat rtk gain                      Show token savings dashboard
  smallchat rtk test git status           Compare raw vs RTK-filtered output
  smallchat rtk test cargo test           Show test output compression ratio
`);

// ---------------------------------------------------------------------------
// rtk setup
// ---------------------------------------------------------------------------

rtkCommand
  .command('setup')
  .description('Detect and install RTK, then configure the Claude Code PreToolUse hook')
  .option('--hook-only', 'Only configure the Claude Code hook (skip RTK install check)')
  .option('--no-hook', 'Skip Claude Code hook setup')
  .action(async (options) => {
    console.log('smallchat rtk setup\n');

    let rtkBin: string | null = null;

    if (!options.hookOnly) {
      console.log('Checking for RTK binary...');
      const foundBin = await which('rtk');

      if (!foundBin) {
        console.log('  ✗ rtk not found on PATH\n');
        console.log('Install RTK with one of:');
        console.log('  brew install rtk                            (macOS/Linux via Homebrew)');
        console.log('  cargo install rtk                           (via Cargo)');
        console.log('  curl -fsSL https://rtk-ai.app/install | sh (direct install)');
        console.log('\nAfter installing, re-run: smallchat rtk setup');
        process.exit(1);
      }

      rtkBin = foundBin;
      const version = await getRtkVersion(foundBin);
      console.log(`  ✓ Found rtk ${version} at ${foundBin}`);

      console.log('\nInitializing RTK global hook...');
      try {
        await runCommand(foundBin, ['init', '--global']);
        console.log('  ✓ RTK global PreToolUse hook installed');
      } catch (err) {
        console.warn(`  ⚠ rtk init --global failed: ${(err as Error).message}`);
        console.warn('    You can configure the hook manually via smallchat rtk setup --hook-only');
      }
    }

    if (options.hook !== false) {
      console.log('\nConfiguring Claude Code project hook...');
      await writeClaudeHook();
      console.log('  ✓ Wrote .claude/settings.json with RTK PreToolUse hook');
    }

    console.log('\nsmallchat × RTK integration ready!');
    console.log('  • Shell commands (git, cargo, npm, etc.) will be automatically compressed');
    console.log('  • Run "smallchat serve --rtk" to enable RTK for MCP server responses');
    console.log('  • Run "smallchat rtk gain" to view token savings statistics');
    console.log('  • Add "rtk": { "enabled": true } to smallchat.json for project-wide config');
  });

// ---------------------------------------------------------------------------
// rtk gain
// ---------------------------------------------------------------------------

rtkCommand
  .command('gain')
  .description('Show RTK token savings analytics dashboard')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const rtkBin = await which('rtk');
    if (!rtkBin) {
      console.error('RTK not found. Run: smallchat rtk setup');
      process.exit(1);
    }

    const args = ['gain'];
    if (options.json) args.push('--json');

    console.log('smallchat × RTK Token Savings\n');

    const proc = spawn(rtkBin, args, { stdio: 'inherit' });
    proc.on('close', (code) => { if (code !== 0) process.exit(code ?? 1); });
  });

// ---------------------------------------------------------------------------
// rtk test
// ---------------------------------------------------------------------------

rtkCommand
  .command('test <command...>')
  .description('Run a command with and without RTK and show token savings')
  .option('--cwd <path>', 'Working directory for the command')
  .action(async (commandParts: string[], options) => {
    const rtkBin = await which('rtk');
    if (!rtkBin) {
      console.error('RTK not found. Run: smallchat rtk setup');
      process.exit(1);
    }

    const command = commandParts.join(' ');
    const cwd = options.cwd ?? process.cwd();

    console.log(`smallchat rtk test: ${command}\n`);

    let rawOutput = '';
    let rtkOutput = '';

    try {
      rawOutput = await captureCommand(command, cwd);
    } catch (err) {
      console.error(`Command failed: ${(err as Error).message}`);
      process.exit(1);
    }

    try {
      rtkOutput = await captureCommand(`rtk ${command}`, cwd);
    } catch {
      rtkOutput = rawOutput;
    }

    const rawBytes = Buffer.byteLength(rawOutput, 'utf8');
    const rtkBytes = Buffer.byteLength(rtkOutput, 'utf8');
    const rawTokens = Math.round(rawBytes / 4);
    const rtkTokens = Math.round(rtkBytes / 4);
    const savedPct = rawBytes > 0 ? Math.round(((rawBytes - rtkBytes) / rawBytes) * 100) : 0;

    console.log('─'.repeat(50));
    console.log(`  Command:        ${command}`);
    console.log(`  Without RTK:    ~${rawTokens} tokens  (${rawBytes} bytes)`);
    console.log(`  With RTK:       ~${rtkTokens} tokens  (${rtkBytes} bytes)`);
    console.log(`  Saved:          ${savedPct}%  (~${rawTokens - rtkTokens} tokens)`);
    console.log('─'.repeat(50));

    if (savedPct > 0) {
      console.log('\nRTK output preview:');
      console.log(rtkOutput.slice(0, 500) + (rtkOutput.length > 500 ? '\n...(truncated)' : ''));
    } else {
      console.log('\n(No savings — command output may already be small or unsupported)');
    }
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getRtkVersion(bin: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], (err, stdout) => {
      resolve(err ? 'unknown' : stdout.trim());
    });
  });
}

function runCommand(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

function captureCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(/\s+/);
    execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error(stderr || err.message));
      else resolve(stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''));
    });
  });
}

async function writeClaudeHook(): Promise<void> {
  const settingsPath = join(process.cwd(), '.claude', 'settings.json');

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch {
    // file doesn't exist yet
  }

  const rtkHook = {
    matcher: 'Bash',
    hooks: [
      {
        type: 'command',
        command: buildRtkHookScript(),
      },
    ],
  };

  const hooks = (existing['hooks'] as Record<string, unknown> | undefined) ?? {};
  const preToolUse = (hooks['PreToolUse'] as unknown[]) ?? [];

  const alreadyInstalled = preToolUse.some(
    (h) => JSON.stringify(h).includes('rtk'),
  );

  if (!alreadyInstalled) {
    preToolUse.push(rtkHook);
  }

  existing['hooks'] = { ...hooks, PreToolUse: preToolUse };

  await writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf8');
}

function buildRtkHookScript(): string {
  const prefixes = [
    'git ', 'cargo ', 'npm ', 'npx ', 'pnpm ', 'yarn ',
    'pytest', 'go test', 'go build',
    'grep ', 'find ', 'ls ', 'eslint', 'tsc',
    'docker ', 'kubectl ',
  ];
  const checkExpr = prefixes
    .map((p) => `c.startsWith(${JSON.stringify(p)})`)
    .join('||');

  return (
    `node -e "const i=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));` +
    `const c=(i.tool_input&&i.tool_input.command)||'';` +
    `const needs=(${checkExpr});` +
    `if(needs&&!c.includes('rtk ')){i.tool_input.command='rtk '+c;}` +
    `process.stdout.write(JSON.stringify(i));"`
  );
}
