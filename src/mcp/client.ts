/**
 * MCP Stdio Client — introspect MCP servers to discover their tools.
 *
 * Spawns a server process, communicates via newline-delimited JSON-RPC 2.0
 * over stdin/stdout, and extracts the tool list for manifest generation.
 */

import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ProviderManifest, ToolDefinition, JSONSchemaType } from '../core/types.js';
import type { ContainerSandboxConfig } from '../transport/types.js';
import { spawnMcpProcess } from '../transport/container-sandbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional container sandbox for process isolation */
  containerSandbox?: ContainerSandboxConfig;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface IntrospectionResult {
  serverId: string;
  serverInfo?: { name: string; version: string };
  tools: McpToolResult[];
  error?: string;
  /** Server capabilities from initialize response */
  capabilities?: Record<string, unknown>;
  /** Server instructions (if provided) */
  instructions?: string;
}

export interface McpToolResult {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Returns true if the parsed JSON object looks like an MCP config file
 * (has an `mcpServers` key that is a non-null object).
 */
export function isMcpConfigFile(obj: unknown): obj is McpConfigFile {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'mcpServers' in obj &&
    typeof (obj as McpConfigFile).mcpServers === 'object' &&
    (obj as McpConfigFile).mcpServers !== null
  );
}

/**
 * Returns true if the directory looks like an MCP server project.
 * Checks package.json for MCP SDK dependency or "mcp" keyword.
 */
export function isMcpServerProject(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    // Check dependencies for MCP SDK
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    if (allDeps['@modelcontextprotocol/sdk']) return true;

    // Check keywords
    if (Array.isArray(pkg.keywords) && pkg.keywords.includes('mcp')) return true;

    // Check name
    if (typeof pkg.name === 'string' && pkg.name.includes('mcp')) return true;

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core introspection
// ---------------------------------------------------------------------------

/**
 * Spawn an MCP server process and discover its tools via JSON-RPC.
 */
export async function introspectMcpServer(
  serverId: string,
  config: McpServerConfig,
  options?: { timeoutMs?: number },
): Promise<IntrospectionResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;

  return new Promise<IntrospectionResult>((resolvePromise) => {
    let settled = false;
    let stderrBuf = '';

    const child = spawnMcpProcess({
      command: config.command,
      args: config.args,
      env: config.env,
      containerSandbox: config.containerSandbox,
    });

    const rl = createInterface({ input: child.stdout, terminal: false });

    // Collect stderr for error messages
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolvePromise({
          serverId,
          tools: [],
          error: `Timeout after ${timeoutMs}ms. stderr: ${stderrBuf.slice(0, 500)}`,
        });
      }
    }, timeoutMs);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          serverId,
          tools: [],
          error: `Failed to spawn "${config.command}": ${err.message}`,
        });
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          serverId,
          tools: [],
          error: `Process exited with code ${code} before responding. stderr: ${stderrBuf.slice(0, 500)}`,
        });
      }
    });

    // State machine for the JSON-RPC conversation
    let phase: 'init' | 'tools' | 'done' = 'init';
    let serverInfo: { name: string; version: string } | undefined;
    let serverCapabilities: Record<string, unknown> | undefined;
    let serverInstructions: string | undefined;

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg: { jsonrpc: string; id?: number; result?: Record<string, unknown>; error?: Record<string, unknown> };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // Skip non-JSON lines (some servers emit log lines to stdout)
      }

      // Only process responses (messages with an id and result/error)
      if (!('id' in msg)) return;

      if (phase === 'init' && msg.id === 1) {
        // Initialize response received
        if (msg.error) {
          settled = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          resolvePromise({
            serverId,
            tools: [],
            error: `Initialize error: ${JSON.stringify(msg.error)}`,
          });
          return;
        }

        serverInfo = msg.result?.serverInfo as { name: string; version: string } | undefined;
        serverCapabilities = msg.result?.capabilities as Record<string, unknown> | undefined;
        serverInstructions = msg.result?.instructions as string | undefined;

        // Send initialized notification
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
        );

        // Send tools/list request
        phase = 'tools';
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
        );
      } else if (phase === 'tools' && msg.id === 2) {
        // tools/list response received
        phase = 'done';
        settled = true;
        clearTimeout(timer);
        child.kill('SIGTERM');

        if (msg.error) {
          resolvePromise({
            serverId,
            serverInfo,
            tools: [],
            error: `tools/list error: ${JSON.stringify(msg.error)}`,
          });
          return;
        }

        const tools = ((msg.result as Record<string, unknown>)?.tools as McpToolResult[]) ?? [];
        resolvePromise({
          serverId,
          serverInfo,
          tools,
          capabilities: serverCapabilities,
          instructions: serverInstructions,
        });
      }
    });

    // Start the conversation: send initialize request
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smallchat', version: '0.1.0' },
        },
      }) + '\n',
    );
  });
}

// ---------------------------------------------------------------------------
// Config file introspection
// ---------------------------------------------------------------------------

/**
 * Parse an MCP config file and introspect each server to build manifests.
 */
export async function introspectMcpConfigFile(
  configPath: string,
  options?: { timeoutMs?: number },
): Promise<ProviderManifest[]> {
  const absPath = resolve(configPath);
  const content = readFileSync(absPath, 'utf-8');
  const parsed = JSON.parse(content);

  if (!isMcpConfigFile(parsed)) {
    throw new Error(`${absPath} does not contain an "mcpServers" key`);
  }

  const entries = Object.entries(parsed.mcpServers);
  if (entries.length === 0) {
    throw new Error(`No servers defined in ${absPath}`);
  }

  const manifests: ProviderManifest[] = [];

  for (const [serverId, config] of entries) {
    console.log(`  Spawning ${config.command} ${(config.args ?? []).join(' ')} (server: ${serverId})...`);

    const result = await introspectMcpServer(serverId, config, options);

    if (result.error) {
      console.error(`  ${serverId}: FAILED — ${result.error}`);
      continue;
    }

    const manifest = introspectionToManifest(result);
    manifests.push(manifest);
    console.log(`  ${serverId}: ${result.tools.length} tools discovered`);
  }

  return manifests;
}

// ---------------------------------------------------------------------------
// Auto-detect from MCP server repo
// ---------------------------------------------------------------------------

/**
 * Detect an MCP server project in the given directory, build if needed,
 * spawn it, and introspect to generate a manifest.
 */
export async function introspectLocalMcpServer(
  projectDir: string,
  options?: { timeoutMs?: number; build?: boolean },
): Promise<ProviderManifest | null> {
  const absDir = resolve(projectDir);
  const pkgPath = join(absDir, 'package.json');

  if (!existsSync(pkgPath)) {
    console.error('No package.json found in current directory.');
    return null;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  if (!isMcpServerProject(absDir)) {
    console.error('Current directory does not appear to be an MCP server project.');
    console.error('  (Looking for @modelcontextprotocol/sdk in dependencies or "mcp" in keywords/name)');
    return null;
  }

  const serverId = (pkg.name as string)?.replace(/^@[^/]+\//, '') ?? 'local';
  const serverName = pkg.name as string ?? serverId;

  // Determine entry point
  let entryPoint: string | null = null;

  // Check bin field
  if (pkg.bin) {
    if (typeof pkg.bin === 'string') {
      entryPoint = pkg.bin;
    } else if (typeof pkg.bin === 'object') {
      // Take the first bin entry, or one matching the package name
      const binName = serverId in pkg.bin ? serverId : Object.keys(pkg.bin)[0];
      entryPoint = pkg.bin[binName];
    }
  }

  // Fall back to main
  if (!entryPoint && pkg.main) {
    entryPoint = pkg.main as string;
  }

  // Fall back to common patterns
  if (!entryPoint) {
    for (const candidate of ['dist/index.js', 'build/index.js', 'index.js']) {
      if (existsSync(join(absDir, candidate))) {
        entryPoint = candidate;
        break;
      }
    }
  }

  if (!entryPoint) {
    console.error('Could not determine entry point. No bin, main, or dist/index.js found.');
    return null;
  }

  const fullEntryPath = resolve(absDir, entryPoint);

  // Build if needed
  if (options?.build !== false && !existsSync(fullEntryPath)) {
    if (pkg.scripts?.build) {
      console.log('  Building project (npm run build)...');
      try {
        execSync('npm run build', { cwd: absDir, stdio: 'pipe' });
      } catch (e) {
        console.error(`  Build failed: ${(e as Error).message}`);
        return null;
      }
    } else {
      console.error(`  Entry point ${entryPoint} does not exist and no build script found.`);
      return null;
    }
  }

  // Check if we need to install dependencies
  if (!existsSync(join(absDir, 'node_modules'))) {
    console.log('  Installing dependencies (npm install)...');
    try {
      execSync('npm install', { cwd: absDir, stdio: 'pipe' });
    } catch (e) {
      console.error(`  npm install failed: ${(e as Error).message}`);
      return null;
    }
  }

  console.log(`  Spawning node ${entryPoint}...`);

  const result = await introspectMcpServer(serverId, {
    command: 'node',
    args: [fullEntryPath],
  }, options);

  if (result.error) {
    console.error(`  Introspection failed: ${result.error}`);
    return null;
  }

  console.log(`  ${serverName}: ${result.tools.length} tools discovered`);

  return introspectionToManifest(result);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an IntrospectionResult to a ProviderManifest.
 */
function introspectionToManifest(result: IntrospectionResult): ProviderManifest {
  const tools: ToolDefinition[] = result.tools.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    inputSchema: (t.inputSchema as unknown as JSONSchemaType) ?? { type: 'object', properties: {} },
    providerId: result.serverId,
    transportType: 'mcp' as const,
  }));

  // Detect channel capabilities from experimental capabilities
  const experimental = (result.capabilities?.experimental ?? {}) as Record<string, unknown>;
  const isChannel = 'claude/channel' in experimental;
  const permissionRelay = 'claude/channel/permission' in experimental;

  // Detect two-way mode: has a reply tool
  const hasReplyTool = result.tools.some(t => t.name === 'reply');
  const replyToolName = result.tools.find(t =>
    t.description?.toLowerCase().includes('reply') ||
    t.description?.toLowerCase().includes('send a reply'),
  )?.name;

  const manifest: ProviderManifest = {
    id: result.serverId,
    name: result.serverInfo?.name ?? result.serverId,
    transportType: 'mcp',
    tools,
  };

  if (isChannel) {
    manifest.channel = {
      isChannel: true,
      twoWay: hasReplyTool || !!replyToolName,
      permissionRelay,
      replyToolName: replyToolName ?? (hasReplyTool ? 'reply' : undefined),
      instructions: result.instructions,
    };
  }

  return manifest;
}
