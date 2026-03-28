import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { isMcpConfigFile, type McpConfigFile } from '../../mcp/client.js';

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

/**
 * Extract the raw mcpServers object from a config file.
 */
function extractMcpServersObject(filePath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (isMcpConfigFile(parsed)) {
      return parsed.mcpServers;
    }

    for (const key of Object.keys(parsed)) {
      const val = parsed[key];
      if (typeof val === 'object' && val !== null && 'mcpServers' in val) {
        return (val as McpConfigFile).mcpServers;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

// ---------------------------------------------------------------------------
// Setup command
// ---------------------------------------------------------------------------

export const setupCommand = new Command('setup')
  .description('Interactive onboarding: discover MCP servers, compile, and install')
  .option('--no-interactive', 'Skip interactive prompts (auto-detect only)')
  .action(async (options) => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║        smallchat setup wizard        ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
    console.log('  This wizard will help you:');
    console.log('    1. Find your MCP server configurations');
    console.log('    2. Compile them into a smallchat toolkit');
    console.log('    3. Optionally replace your mcpServers with the compiled toolkit');
    console.log('');

    const prompt = createPrompt();

    try {
      // Step 1: Discover MCP servers
      let configPath: string | null = null;

      if (options.interactive === false) {
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
        prompt.close();
        return;
      }

      // Show what we found
      const servers = extractMcpServersObject(configPath);
      const serverNames = servers ? Object.keys(servers) : [];
      console.log(`\nFound ${serverNames.length} MCP server(s) in ${configPath}:`);
      for (const name of serverNames) {
        console.log(`  - ${name}`);
      }

      // Step 2: Compile
      if (options.interactive !== false) {
        const shouldCompile = await prompt.confirm('\nCompile these servers into a smallchat toolkit?');
        if (!shouldCompile) {
          console.log('\nSetup cancelled.');
          prompt.close();
          return;
        }
      }

      console.log('');

      // Run compile by importing and invoking compile logic
      const outputPath = resolve('tools.toolkit.json');
      const compileOk = await runCompileFromConfig(configPath, outputPath);

      if (!compileOk) {
        console.log('\nCompilation failed. Run "smallchat doctor" to diagnose issues.');
        prompt.close();
        return;
      }

      // Step 3: Offer to replace mcpServers
      if (options.interactive !== false) {
        console.log('');
        const shouldReplace = await prompt.confirm(
          'Replace your current mcpServers tool list with the compiled smallchat tool list?',
        );

        if (shouldReplace) {
          const success = replaceMcpServers(configPath, outputPath);
          if (success) {
            console.log('\nDone! Your mcpServers have been updated.');
            console.log(`Original config backed up to: ${configPath}.backup`);
            console.log('');
            console.log('Your tools are now served through smallchat.');
            console.log('To revert, restore the backup file.');
          } else {
            console.log('\nFailed to update config. You can do this manually.');
          }
        } else {
          console.log('\nSkipped. Your compiled toolkit is ready at:');
          console.log(`  ${outputPath}`);
          console.log('');
          console.log('To serve it manually:');
          console.log(`  smallchat serve --source ${outputPath}`);
        }
      }

      console.log('');
      prompt.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
        // readline closed unexpectedly (e.g. piped input ended)
        return;
      }
      throw err;
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
  configPath: string,
  outputPath: string,
): Promise<boolean> {
  // Dynamically import compile dependencies to avoid loading them until needed
  const { introspectMcpConfigFile } = await import('../../mcp/client.js');
  const { ToolCompiler } = await import('../../compiler/compiler.js');
  const { LocalEmbedder } = await import('../../embedding/local-embedder.js');
  const { MemoryVectorIndex } = await import('../../embedding/memory-vector-index.js');

  let manifests;
  try {
    console.log('Introspecting MCP servers...\n');
    manifests = await introspectMcpConfigFile(configPath);
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

  // Try ONNX first, fall back to local
  let embedder;
  let embedderLabel: string;
  try {
    const { ONNXEmbedder } = await import('../../embedding/onnx-embedder.js');
    embedder = new ONNXEmbedder();
    embedderLabel = 'all-MiniLM-L6-v2 (ONNX)';
  } catch {
    embedder = new LocalEmbedder();
    embedderLabel = 'hash-based (local)';
  }

  const vectorIndex = new MemoryVectorIndex();
  const compiler = new ToolCompiler(embedder, vectorIndex);

  console.log(`\nCompiling with ${embedderLabel}...`);

  const result = await compiler.compile(manifests);

  console.log(`  Selectors: ${result.uniqueSelectorCount}`);
  console.log(`  Tools: ${result.toolCount}`);
  console.log(`  Providers: ${result.dispatchTables.size}`);

  if (result.collisions.length > 0) {
    console.log(`  Collisions: ${result.collisions.length}`);
  }

  // Serialize output
  const selectors: Record<string, object> = {};
  for (const [key, sel] of result.selectors) {
    selectors[key] = {
      canonical: sel.canonical,
      parts: sel.parts,
      arity: sel.arity,
      vector: Array.from(sel.vector),
    };
  }

  const dispatchTables: Record<string, Record<string, object>> = {};
  for (const [providerId, table] of result.dispatchTables) {
    const methods: Record<string, object> = {};
    for (const [canonical, imp] of table) {
      methods[canonical] = {
        providerId: imp.providerId,
        toolName: imp.toolName,
        transportType: imp.transportType,
      };
    }
    dispatchTables[providerId] = methods;
  }

  const output = {
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    embedding: {
      model: embedderLabel.includes('ONNX') ? 'all-MiniLM-L6-v2' : 'hash-based',
      dimensions: 384,
      embedderType: embedderLabel.includes('ONNX') ? 'onnx' : 'local',
    },
    stats: {
      toolCount: result.toolCount,
      uniqueSelectorCount: result.uniqueSelectorCount,
      mergedCount: result.mergedCount,
      providerCount: result.dispatchTables.size,
      collisionCount: result.collisions.length,
    },
    selectors,
    dispatchTables,
    collisions: result.collisions,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nCompiled toolkit written to: ${outputPath}`);

  return true;
}

// ---------------------------------------------------------------------------
// Config replacement
// ---------------------------------------------------------------------------

function replaceMcpServers(
  originalConfigPath: string,
  toolkitPath: string,
): boolean {
  try {
    const content = readFileSync(originalConfigPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Back up the original
    writeFileSync(`${originalConfigPath}.backup`, content);

    // Build the smallchat MCP server entry
    const absoluteToolkitPath = resolve(toolkitPath);
    const smallchatServer = {
      command: 'npx',
      args: ['smallchat', 'serve', '--source', absoluteToolkitPath],
    };

    // Replace mcpServers at the appropriate level
    if (isMcpConfigFile(parsed)) {
      parsed.mcpServers = { smallchat: smallchatServer };
      writeFileSync(originalConfigPath, JSON.stringify(parsed, null, 2));
      return true;
    }

    // Handle nested mcpServers (e.g. VS Code settings)
    for (const key of Object.keys(parsed)) {
      const val = parsed[key];
      if (typeof val === 'object' && val !== null && 'mcpServers' in val) {
        val.mcpServers = { smallchat: smallchatServer };
        writeFileSync(originalConfigPath, JSON.stringify(parsed, null, 2));
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error(`Error updating config: ${(err as Error).message}`);
    return false;
  }
}
