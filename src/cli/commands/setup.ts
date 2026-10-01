import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { isMcpConfigFile } from '../../mcp/client.js';
import { connectMcp, listAllTools } from '../../transport/mcp-connect.js';
import { PACKAGE_NAME, localCliPath, packageVersion } from '../package-info.js';

/** Name of the entry setup adds to mcpServers. */
export const SMALLCHAT_SERVER_NAME = 'smallchat';

/**
 * Sibling key that holds the servers `--disable-originals` set aside, in the
 * same object as `mcpServers`. Hosts ignore it; setup compiles from it on
 * later runs.
 */
export const DISABLED_SERVERS_KEY = 'smallchatDisabledMcpServers';

// ---------------------------------------------------------------------------
// Interactive prompt helpers
// ---------------------------------------------------------------------------

function createPrompt(): {
  ask: (question: string) => Promise<string>;
  choose: (question: string, options: string[]) => Promise<number>;
  confirm: (question: string) => Promise<boolean>;
  close: () => void;
} {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question: string): Promise<string> =>
    new Promise((res) => rl.question(question, (answer) => res(answer.trim())));

  const choose = async (question: string, options: string[]): Promise<number> => {
    console.log(`\n${question}\n`);
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${i + 1}) ${options[i]}`);
    }
    console.log('');

    while (true) {
      const answer = await ask(`Enter choice (1-${options.length}): `);
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= options.length) {
        return num - 1;
      }
      console.log(`  Please enter a number between 1 and ${options.length}.`);
    }
  };

  const confirm = async (question: string): Promise<boolean> => {
    const answer = await ask(`${question} (y/n): `);
    return answer.toLowerCase().startsWith('y');
  };

  return { ask, choose, confirm, close: () => rl.close() };
}

// ---------------------------------------------------------------------------
// Known CLI tool MCP config locations
// ---------------------------------------------------------------------------

interface CliToolInfo {
  name: string;
  label: string;
  configPaths: string[];
}

function getCliTools(): CliToolInfo[] {
  const home = homedir();

  return [
    {
      name: 'claude-code',
      label: 'Claude Code',
      configPaths: [
        join(home, '.claude', 'settings.json'),
        join(home, '.claude.json'),
        '.mcp.json',
      ],
    },
    {
      name: 'gemini-cli',
      label: 'Gemini CLI',
      configPaths: [
        join(home, '.gemini', 'settings.json'),
        join(home, '.gemini', 'config.json'),
      ],
    },
    {
      name: 'opencode',
      label: 'OpenCode',
      configPaths: [
        join(home, '.opencode', 'config.json'),
        join(home, '.config', 'opencode', 'config.json'),
      ],
    },
    {
      name: 'codex',
      label: 'Codex CLI',
      configPaths: [
        join(home, '.codex', 'config.json'),
        join(home, '.config', 'codex', 'config.json'),
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Standard auto-detect locations
// ---------------------------------------------------------------------------

function getAutoDetectPaths(): string[] {
  const home = homedir();
  return [
    // Project-local
    resolve('.mcp.json'),
    resolve('mcp.json'),
    // Claude Code
    join(home, '.claude', 'settings.json'),
    join(home, '.claude.json'),
    // Claude Desktop (macOS)
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    // Claude Desktop (Linux)
    join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    // VS Code
    join(home, '.vscode', 'settings.json'),
    // Gemini CLI
    join(home, '.gemini', 'settings.json'),
    // OpenCode
    join(home, '.opencode', 'config.json'),
    join(home, '.config', 'opencode', 'config.json'),
    // Codex
    join(home, '.codex', 'config.json'),
    join(home, '.config', 'codex', 'config.json'),
  ];
}

// ---------------------------------------------------------------------------
// Config file parsing
// ---------------------------------------------------------------------------

interface DiscoveredConfig {
  path: string;
  serverCount: number;
  serverNames: string[];
}

/**
 * Try to extract mcpServers from a file. Handles both top-level
 * `{ "mcpServers": {...} }` and nested structures like VS Code settings.
 */
function tryExtractMcpServers(filePath: string): DiscoveredConfig | null {
  if (!existsSync(filePath)) return null;

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;

    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    // Direct mcpServers key
    if (isMcpConfigFile(parsed)) {
      const names = Object.keys(parsed.mcpServers);
      if (names.length > 0) {
        return { path: filePath, serverCount: names.length, serverNames: names };
      }
    }

    // Nested under a parent key (e.g. VS Code settings)
    for (const key of Object.keys(parsed)) {
      const val = parsed[key];
      if (typeof val === 'object' && val !== null && 'mcpServers' in val) {
        const names = Object.keys(val.mcpServers);
        if (names.length > 0) {
          return { path: filePath, serverCount: names.length, serverNames: names };
        }
      }
    }
  } catch {
    // Not valid JSON or unreadable
  }

  return null;
}

// ---------------------------------------------------------------------------
// Setup command
// ---------------------------------------------------------------------------

export const setupCommand = new Command('setup')
  .description('Interactive onboarding: discover MCP servers, compile, and add smallchat to your MCP config')
  .option('--no-interactive', 'Skip interactive prompts (auto-detect, or --config)')
  .option('--config <path>', 'MCP config file to use (skips discovery)')
  .option('-o, --output <path>', 'Where to write the compiled toolkit', 'tools.toolkit.json')
  .option('--embedder <kind>', 'Embedder to compile with: onnx (default; falls back to hash) or hash')
  .option('--install', 'Non-interactive: add the smallchat server to the config')
  .option('--disable-originals', 'Move the original servers aside (kept in the file under "smallchatDisabledMcpServers")')
  .option('--launcher <kind>', `How the config launches smallchat: npx (npx -y ${PACKAGE_NAME}@<version>) or node (absolute path to this install)`, 'npx')
  .option('--no-verify', 'Do not start the compiled toolkit over stdio before writing the config')
  .action(async (options) => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║        smallchat setup wizard        ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
    console.log('  This wizard will help you:');
    console.log('    1. Find your MCP server configurations');
    console.log('    2. Compile them into a smallchat toolkit');
    console.log('    3. Optionally add smallchat to your mcpServers (your servers stay)');
    console.log('');

    if (options.launcher !== 'npx' && options.launcher !== 'node') {
      console.error(`--launcher must be "npx" or "node" (got "${options.launcher}")`);
      process.exitCode = 1;
      return;
    }

    const interactive = options.interactive !== false;
    const prompt = interactive ? createPrompt() : null;

    try {
      // Step 1: Discover MCP servers
      let configPath: string | null = null;

      if (options.config) {
        configPath = resolve(options.config);
        if (!tryExtractMcpServers(configPath)) {
          console.error(`No "mcpServers" configuration found in ${configPath}`);
          process.exitCode = 1;
          return;
        }
      } else if (!prompt) {
        // Non-interactive: auto-detect only
        configPath = await autoDetect(null);
      } else {
        const choice = await prompt.choose(
          'How would you like to find your MCP servers?',
          [
            'Auto-detect (scan standard config locations)',
            'Paste a file path to an .mcp.json or settings.json',
            'Select your CLI tool (Claude Code, Gemini CLI, OpenCode, Codex)',
          ],
        );

        switch (choice) {
          case 0:
            configPath = await autoDetect(prompt);
            break;
          case 1:
            configPath = await pasteFilePath(prompt);
            break;
          case 2:
            configPath = await selectCliTool(prompt);
            break;
        }
      }

      if (!configPath) {
        console.log('\nNo MCP server configuration found. Exiting setup.');
        console.log('');
        console.log('You can still compile manually:');
        console.log('  smallchat compile --source <path-to-mcp-config>');
        console.log('');
        return;
      }

      // Show what we found (smallchat's own entry is never compiled into itself)
      const servers = serversToCompile(JSON.parse(readFileSync(configPath, 'utf-8')));
      const serverNames = Object.keys(servers);
      console.log(`\nFound ${serverNames.length} MCP server(s) to compile in ${configPath}:`);
      for (const name of serverNames) {
        console.log(`  - ${name}`);
      }
      if (serverNames.length === 0) {
        console.log('\nNothing to compile.');
        return;
      }

      // Step 2: Compile
      if (prompt) {
        const shouldCompile = await prompt.confirm('\nCompile these servers into a smallchat toolkit?');
        if (!shouldCompile) {
          console.log('\nSetup cancelled.');
          return;
        }
      }

      console.log('');

      const outputPath = resolve(options.output);
      const compileOk = await runCompileFromConfig(servers, outputPath, options.embedder);

      if (!compileOk) {
        console.log('\nCompilation failed. Run "smallchat doctor" to diagnose issues.');
        process.exitCode = 1;
        return;
      }

      // Step 3: Offer to add smallchat to the config
      let install = options.install === true;
      let disableOriginals = options.disableOriginals === true;
      if (prompt) {
        console.log('');
        install = await prompt.confirm(
          `Add a "${SMALLCHAT_SERVER_NAME}" server to ${basename(configPath)}? Your existing servers stay.`,
        );
        if (install && !options.disableOriginals) {
          disableOriginals = await prompt.confirm(
            `Also disable the original servers, so their tools are not listed twice? (They move to "${DISABLED_SERVERS_KEY}" in the same file.)`,
          );
        }
      }

      if (!install) {
        console.log('\nYour compiled toolkit is ready at:');
        console.log(`  ${outputPath}`);
        console.log('');
        console.log('To serve it (stdio, for an MCP host):');
        console.log(`  npx -y ${PACKAGE_NAME}@${packageVersion()} serve --source ${outputPath}`);
        console.log('');
        return;
      }

      const launch = { launcher: options.launcher as 'npx' | 'node' };
      if (options.verify !== false) {
        const cli = localCliPath();
        if (!cli) {
          console.log('\nSkipping the serve check (smallchat is running from its TypeScript sources).');
        } else {
          console.log('\nChecking that the toolkit serves over stdio...');
          try {
            const tools = await verifyServeEntry(smallchatServerEntry(outputPath, { launcher: 'node', cliPath: cli }));
            console.log(`  ✓ initialize completed; ${tools.length} tool(s) listed`);
          } catch (err) {
            console.error(`  ✗ ${(err as Error).message}`);
            console.error('\nThe config was not changed. Fix the error above, or re-run with --no-verify.');
            process.exitCode = 1;
            return;
          }
        }
      }

      let result: InstallResult;
      try {
        result = installSmallchatEntry(configPath, outputPath, { ...launch, disableOriginals });
      } catch (err) {
        console.error(`\nFailed to update ${configPath}: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      console.log(`\nDone! Added "${SMALLCHAT_SERVER_NAME}" to ${configPath}:`);
      console.log(`  ${result.entry.command} ${result.entry.args.join(' ')}`);
      if (result.disabled.length > 0) {
        console.log(`Disabled (kept under "${DISABLED_SERVERS_KEY}"): ${result.disabled.join(', ')}`);
      }
      console.log(`Original config backed up to: ${result.backupPath}`);
      console.log('To revert, copy the backup over the config.');
      console.log('');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
        // readline closed unexpectedly (e.g. piped input ended)
        return;
      }
      throw err;
    } finally {
      prompt?.close();
    }
  });

// ---------------------------------------------------------------------------
// Discovery strategies
// ---------------------------------------------------------------------------

async function autoDetect(
  prompt: ReturnType<typeof createPrompt> | null,
): Promise<string | null> {
  console.log('\nScanning standard locations for MCP server configs...\n');

  const paths = getAutoDetectPaths();
  const found: DiscoveredConfig[] = [];

  for (const p of paths) {
    const result = tryExtractMcpServers(p);
    if (result) {
      found.push(result);
      console.log(`  Found: ${result.path}`);
      console.log(`         ${result.serverCount} server(s): ${result.serverNames.join(', ')}`);
    }
  }

  if (found.length === 0) {
    console.log('  No MCP server configurations found in standard locations.');
    return null;
  }

  if (found.length === 1) {
    console.log(`\nUsing: ${found[0].path}`);
    return found[0].path;
  }

  // Multiple found — let user pick
  if (prompt) {
    const choice = await prompt.choose(
      'Multiple configurations found. Which one would you like to use?',
      found.map((f) => `${basename(f.path)} (${dirname(f.path)}) — ${f.serverCount} server(s)`),
    );
    return found[choice].path;
  }

  // Non-interactive: use the one with most servers
  const best = found.reduce((a, b) => (a.serverCount >= b.serverCount ? a : b));
  console.log(`\nUsing: ${best.path} (${best.serverCount} servers)`);
  return best.path;
}

async function pasteFilePath(
  prompt: ReturnType<typeof createPrompt>,
): Promise<string | null> {
  const rawPath = await prompt.ask('\nEnter the path to your .mcp.json or settings.json file:\n> ');

  if (!rawPath) {
    return null;
  }

  // Expand ~ to homedir
  const expanded = rawPath.startsWith('~')
    ? join(homedir(), rawPath.slice(1))
    : rawPath;
  const resolved = resolve(expanded);

  if (!existsSync(resolved)) {
    console.log(`\n  File not found: ${resolved}`);
    return null;
  }

  const result = tryExtractMcpServers(resolved);
  if (!result) {
    console.log(`\n  No "mcpServers" configuration found in ${resolved}`);
    console.log('  The file should contain a JSON object with an "mcpServers" key.');
    return null;
  }

  return resolved;
}

async function selectCliTool(
  prompt: ReturnType<typeof createPrompt>,
): Promise<string | null> {
  const tools = getCliTools();

  const choice = await prompt.choose(
    'Which CLI tool are you using?',
    tools.map((t) => t.label),
  );

  const tool = tools[choice];
  console.log(`\nSearching for ${tool.label} MCP configurations...\n`);

  const found: DiscoveredConfig[] = [];

  for (const configPath of tool.configPaths) {
    const resolved = resolve(configPath);
    const result = tryExtractMcpServers(resolved);
    if (result) {
      found.push(result);
      console.log(`  Found: ${result.path}`);
      console.log(`         ${result.serverCount} server(s): ${result.serverNames.join(', ')}`);
    }
  }

  if (found.length === 0) {
    console.log(`  No MCP server configurations found for ${tool.label}.`);
    console.log(`  Checked: ${tool.configPaths.join(', ')}`);

    const tryPaste = await prompt.confirm('\nWould you like to paste a file path instead?');
    if (tryPaste) {
      return pasteFilePath(prompt);
    }
    return null;
  }

  if (found.length === 1) {
    return found[0].path;
  }

  const pick = await prompt.choose(
    'Multiple configurations found:',
    found.map((f) => `${f.path} — ${f.serverCount} server(s)`),
  );
  return found[pick].path;
}

// ---------------------------------------------------------------------------
// Compile integration
// ---------------------------------------------------------------------------

async function runCompileFromConfig(
  servers: Record<string, unknown>,
  outputPath: string,
  embedderKind?: string,
): Promise<boolean> {
  // Dynamically import compile dependencies to avoid loading them until needed
  const { introspectMcpServers } = await import('../../mcp/client.js');
  const { ToolCompiler } = await import('../../compiler/compiler.js');
  const { MemoryVectorIndex } = await import('../../embedding/memory-vector-index.js');
  const { buildArtifact } = await import('../../artifact/format.js');
  const { writeArtifact } = await import('../../artifact/io.js');
  const { createEmbedder, describeFingerprint, fingerprintOf, DEFAULT_EMBEDDER_KIND } =
    await import('../../artifact/embedder.js');

  if (embedderKind !== undefined && embedderKind !== 'onnx' && embedderKind !== 'hash') {
    console.error(`--embedder must be "onnx" or "hash" (got "${embedderKind}")`);
    return false;
  }

  let manifests;
  try {
    console.log('Introspecting MCP servers...\n');
    manifests = await introspectMcpServers(servers);
  } catch (err) {
    console.error(`Introspection failed: ${(err as Error).message}`);
    return false;
  }

  if (manifests.length === 0) {
    console.error('No tools discovered from any server.');
    return false;
  }

  const totalTools = manifests.reduce((sum, m) => sum + m.tools.length, 0);
  console.log(`\nDiscovered ${totalTools} tool(s) across ${manifests.length} server(s).`);

  // The compile default (ONNX); if its model is unavailable, fall back to
  // the hash embedder. The artifact records whichever was actually used, so
  // `serve` will load it with the same embedder.
  let embedder;
  if (embedderKind === 'hash') {
    embedder = await createEmbedder('hash');
  } else {
    try {
      embedder = await createEmbedder(DEFAULT_EMBEDDER_KIND);
    } catch (err) {
      console.warn(`Warning: ${(err as Error).message}`);
      console.warn('  Falling back to the hash embedder (placeholder vectors; run "smallchat doctor").');
      embedder = await createEmbedder('hash');
    }
  }
  const fingerprint = fingerprintOf(embedder);

  // The wizard keeps near-duplicate tools (reported below) rather than
  // failing a first-run setup; `smallchat compile` treats them as errors.
  const compiler = new ToolCompiler(embedder, new MemoryVectorIndex(), { allowDuplicates: true });

  console.log(`\nCompiling with ${describeFingerprint(fingerprint)}...`);

  const result = await compiler.compile(manifests);

  console.log(`  Selectors: ${result.uniqueSelectorCount}`);
  console.log(`  Tools: ${result.toolCount}`);
  console.log(`  Providers: ${result.dispatchTables.size}`);

  if (result.collisions.length > 0) {
    console.log(`  Collisions: ${result.collisions.length}`);
  }
  for (const d of result.duplicates) {
    console.log(`  ⚠ Near-duplicate tools: ${d.toolA} <-> ${d.toolB} (cosine: ${d.similarity.toFixed(3)})`);
  }

  await writeArtifact(outputPath, buildArtifact(result, manifests, fingerprint));
  console.log(`\nCompiled toolkit written to: ${outputPath}`);

  return true;
}

// ---------------------------------------------------------------------------
// Config installation
// ---------------------------------------------------------------------------

/** The stdio entry that launches `smallchat serve` for a toolkit. */
export interface SmallchatServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
}

export interface LaunchOptions {
  /**
   * 'npx' (default): `npx -y @smallchat/core@<version> serve --source <toolkit>`
   * — the scoped package at this exact version, never the unscoped
   * `smallchat` name (unregistered on npm, so anyone could claim it).
   * 'node': this installation's CLI by absolute path.
   */
  launcher?: 'npx' | 'node';
  /** Version to pin with the npx launcher (default: this package's version) */
  version?: string;
  /** CLI entry point for the node launcher (default: this installation's dist/cli/index.js) */
  cliPath?: string;
}

/** The mcpServers entry that serves `toolkitPath` over stdio. */
export function smallchatServerEntry(toolkitPath: string, options: LaunchOptions = {}): SmallchatServerEntry {
  const source = resolve(toolkitPath);
  if (options.launcher === 'node') {
    const cliPath = options.cliPath ?? localCliPath();
    if (!cliPath) {
      throw new Error('--launcher node needs the compiled CLI (dist/cli/index.js); this smallchat runs from sources');
    }
    if (/[\\/]_npx[\\/]/.test(cliPath)) {
      throw new Error(`${cliPath} is in the npx cache, which npm may delete; use --launcher npx or install ${PACKAGE_NAME}`);
    }
    return { type: 'stdio', command: process.execPath, args: [cliPath, 'serve', '--source', source] };
  }
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', `${PACKAGE_NAME}@${options.version ?? packageVersion()}`, 'serve', '--source', source],
  };
}

export interface InstallOptions extends LaunchOptions {
  /** Move the other servers under DISABLED_SERVERS_KEY (kept, not deleted) */
  disableOriginals?: boolean;
  /** Clock for the backup file name (tests) */
  now?: Date;
}

export interface InstallResult {
  /** The backup of the config as it was before this change */
  backupPath: string;
  entry: SmallchatServerEntry;
  /** Servers moved under DISABLED_SERVERS_KEY by this call */
  disabled: string[];
}

/**
 * Add (or update) the smallchat entry in a config's mcpServers, next to
 * the servers already there. Never deletes a server: with
 * `disableOriginals`, the others move under DISABLED_SERVERS_KEY in the
 * same object, verbatim. The config is backed up first to
 * `<config>.smallchat-backup-<timestamp>`, a new file every time (never
 * overwritten), and rewritten atomically. A config that is not valid JSON
 * is left untouched and an error is thrown.
 */
export function installSmallchatEntry(
  configPath: string,
  toolkitPath: string,
  options: InstallOptions = {},
): InstallResult {
  const content = readFileSync(configPath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON (${(err as Error).message}); nothing was changed`);
  }
  const container = mcpServersContainer(parsed);
  if (!container) throw new Error(`${configPath} has no "mcpServers" object; nothing was changed`);

  const entry = smallchatServerEntry(toolkitPath, options);
  // The backup may hold tokens (env values): give it the config's own mode.
  const backupPath = writeBackup(configPath, content, options.now ?? new Date(), statSync(configPath).mode & 0o777);

  const current = container.mcpServers as Record<string, unknown>;
  const disabled: string[] = [];
  let servers: Record<string, unknown>;
  if (options.disableOriginals) {
    const aside = { ...((container[DISABLED_SERVERS_KEY] as Record<string, unknown> | undefined) ?? {}) };
    for (const [name, server] of Object.entries(current)) {
      if (name === SMALLCHAT_SERVER_NAME) continue;
      aside[name] = server;
      disabled.push(name);
    }
    container[DISABLED_SERVERS_KEY] = aside;
    servers = { [SMALLCHAT_SERVER_NAME]: entry };
  } else {
    servers = { ...current, [SMALLCHAT_SERVER_NAME]: entry };
  }
  container.mcpServers = servers;

  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', { mode: statSync(configPath).mode & 0o777 });
  renameSync(tmp, configPath);
  return { backupPath, entry, disabled };
}

/**
 * The servers setup should compile from a parsed config: its mcpServers
 * without smallchat's own entry, plus the servers an earlier
 * `--disable-originals` set aside.
 */
export function serversToCompile(parsed: unknown): Record<string, unknown> {
  const container = mcpServersContainer(parsed);
  if (!container) return {};
  const servers: Record<string, unknown> = {
    ...((container[DISABLED_SERVERS_KEY] as Record<string, unknown> | undefined) ?? {}),
    ...(container.mcpServers as Record<string, unknown>),
  };
  delete servers[SMALLCHAT_SERVER_NAME];
  return servers;
}

/**
 * Start an entry the way an MCP host would (stdio), complete initialize and
 * list its tools; returns the tool names. Rejects if it does not speak MCP.
 */
export async function verifyServeEntry(
  entry: { command: string; args: string[] },
  options: { timeoutMs?: number } = {},
): Promise<string[]> {
  const connection = await connectMcp(
    { transport: 'stdio', command: entry.command, args: entry.args },
    { timeoutMs: options.timeoutMs ?? 60_000 },
  );
  try {
    const tools = await listAllTools(connection.client, { timeoutMs: options.timeoutMs ?? 60_000 });
    return tools.map(t => t.name);
  } finally {
    await connection.close();
  }
}

/** The object holding `mcpServers` (top level, or one level down as in editor settings). */
function mcpServersContainer(parsed: unknown): Record<string, unknown> | null {
  if (isMcpConfigFile(parsed)) return parsed as unknown as Record<string, unknown>;
  if (typeof parsed !== 'object' || parsed === null) return null;
  for (const value of Object.values(parsed)) {
    if (typeof value === 'object' && value !== null && isMcpConfigFile(value)) {
      return value as unknown as Record<string, unknown>;
    }
  }
  return null;
}

/** Write `<config>.smallchat-backup-<timestamp>[-n]`, never replacing an existing file. */
function writeBackup(configPath: string, content: string, now: Date, mode: number): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (let n = 0; ; n++) {
    const path = `${configPath}.smallchat-backup-${stamp}${n === 0 ? '' : `-${n}`}`;
    try {
      writeFileSync(path, content, { flag: 'wx', mode });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}
