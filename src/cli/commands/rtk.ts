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
import { writeFile, readFile, mkdir, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { which } from '../../transport/rtk-which.js';

/** File name of the PreToolUse hook script `rtk setup` installs under .claude/hooks/. */
export const RTK_HOOK_SCRIPT = 'smallchat-rtk-rewrite.mjs';

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
      try {
        const { installed } = await writeClaudeHook(process.cwd());
        console.log(`  ✓ Wrote .claude/hooks/${RTK_HOOK_SCRIPT}`);
        console.log(installed
          ? '  ✓ Registered it as a PreToolUse hook in .claude/settings.json'
          : '  ✓ Already registered in .claude/settings.json');
      } catch (err) {
        console.error(`  ✗ ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
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

/**
 * Install the RTK PreToolUse hook into `<projectDir>/.claude/`: the hook
 * script under .claude/hooks/ and its registration in settings.json.
 *
 * settings.json is edited, never replaced: every existing key (permissions,
 * env, other hooks) is kept, and a file that is not valid JSON is left
 * untouched — the call throws instead. The write is atomic (temp file +
 * rename). The hook is registered once; hooks earlier smallchat versions
 * installed inline (which never ran) are replaced.
 */
export async function writeClaudeHook(projectDir: string): Promise<{ installed: boolean }> {
  const claudeDir = join(projectDir, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  let existing: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (raw !== null && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${settingsPath} is not valid JSON (${(err as Error).message}). Fix it and re-run; nothing was changed.`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${settingsPath} is not a JSON object; nothing was changed.`);
    }
    existing = parsed as Record<string, unknown>;
  }

  const hooks = existing['hooks'] ?? {};
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    throw new Error(`${settingsPath}: "hooks" is not an object; nothing was changed.`);
  }
  const preToolUse = (hooks as Record<string, unknown>)['PreToolUse'] ?? [];
  if (!Array.isArray(preToolUse)) {
    throw new Error(`${settingsPath}: "hooks.PreToolUse" is not an array; nothing was changed.`);
  }

  await mkdir(join(claudeDir, 'hooks'), { recursive: true });
  const scriptPath = join(claudeDir, 'hooks', RTK_HOOK_SCRIPT);
  await writeFile(scriptPath, buildRtkHookScript(), 'utf8');
  await chmod(scriptPath, 0o755);

  // Drop the inline `node -e` hook older versions wrote (a quoting bug made
  // it a SyntaxError on every Bash call), keeping everything else.
  const kept = preToolUse
    .map((entry) => withoutLegacyRtkHook(entry))
    .filter((entry) => entry !== null);
  const installed = !kept.some((entry) => JSON.stringify(entry).includes(RTK_HOOK_SCRIPT));
  if (installed) {
    kept.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${RTK_HOOK_SCRIPT}"` }],
    });
  }

  existing['hooks'] = { ...(hooks as Record<string, unknown>), PreToolUse: kept };

  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  await rename(tmp, settingsPath);
  return { installed };
}

/** The legacy inline hook's signature (smallchat <= 0.5). */
const LEGACY_HOOK_MARKER = "readFileSync('/dev/stdin','utf8'));const c=(i.tool_input";

function withoutLegacyRtkHook(entry: unknown): unknown | null {
  if (typeof entry !== 'object' || entry === null) return entry;
  const list = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(list)) return entry;
  const remaining = list.filter((hook) => !(typeof (hook as { command?: unknown })?.command === 'string'
    && ((hook as { command: string }).command).includes(LEGACY_HOOK_MARKER)));
  if (remaining.length === list.length) return entry;
  return remaining.length === 0 ? null : { ...entry, hooks: remaining };
}

const HOOK_PREFIXES = [
  'git ', 'cargo ', 'npm ', 'npx ', 'pnpm ', 'yarn ',
  'pytest', 'go test', 'go build',
  'grep ', 'find ', 'ls ', 'eslint', 'tsc',
  'docker ', 'kubectl ',
];

/**
 * The hook script: reads Claude Code's PreToolUse input from stdin and, for
 * an eligible Bash command, prints `hookSpecificOutput.updatedInput` with
 * the command prefixed by `rtk `. It sets no permissionDecision, so Claude
 * Code's permission rules still apply (to the rewritten command). Anything
 * unexpected prints nothing and exits 0: the command runs unchanged.
 */
export function buildRtkHookScript(): string {
  return `#!/usr/bin/env node
// Installed by \`smallchat rtk setup\`: a Claude Code PreToolUse hook for Bash
// that runs eligible commands through RTK ("git status" -> "rtk git status")
// by returning hookSpecificOutput.updatedInput. It makes no permission
// decision: Claude Code's permission rules apply to the rewritten command.
// On any unexpected input it prints nothing, and the command runs unchanged.
const PREFIXES = ${JSON.stringify(HOOK_PREFIXES)};

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (!input || input.tool_name !== 'Bash') return;
    const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const command = typeof toolInput.command === 'string' ? toolInput.command.trimStart() : '';
    if (!command || command.startsWith('rtk ')) return;
    if (!PREFIXES.some((p) => command.startsWith(p) || command === p.trim())) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...toolInput, command: 'rtk ' + command },
      },
    }));
  } catch {
    // Not a hook payload we understand: leave the tool call alone.
  }
});
`;
}
