/**
 * MCP config introspection — connect to the MCP servers a config file
 * lists and discover their tools, for manifest generation.
 *
 * Understands the `mcpServers` shapes hosts write: stdio entries
 * (`command`, `args`, `env`, `cwd`) and remote ones (`type: "http"` /
 * `"streamable-http"` / `"sse"` with `url` and `headers`; a bare `url` is
 * tried as Streamable HTTP, then legacy SSE). `${VAR}` and
 * `${VAR:-default}` are expanded as Claude Code expands them. Every
 * connection goes through the official SDK client (transport/mcp-connect),
 * and tools/list is read to its last page.
 *
 * One bad entry never fails the scan: it is reported and skipped.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ProviderManifest, ToolDefinition, JSONSchemaType, LaunchSpec, ToolAnnotations } from '../core/types.js';
import type { ContainerSandboxConfig } from '../transport/types.js';
import { connectMcp, listAllTools, expandEnvRefs, MissingEnvVarError, type McpConnectSpec } from '../transport/mcp-connect.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A stdio server entry: smallchat starts it. */
export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Optional container sandbox for process isolation */
  containerSandbox?: ContainerSandboxConfig;
}

/** A remote server entry: smallchat connects to its URL. */
export interface McpRemoteServerConfig {
  /** 'http' and 'streamable-http' are Streamable HTTP; 'sse' is legacy HTTP+SSE; omitted tries both */
  type?: 'http' | 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface IntrospectOptions {
  /** Per-server timeout for connecting and listing tools (default 30 s) */
  timeoutMs?: number;
  /** Where ${VAR} references are read from (default process.env) */
  env?: Record<string, string | undefined>;
  /** Progress and skip messages (default: console.log / console.error) */
  log?: (line: string) => void;
  /** Server ids to leave out (e.g. smallchat's own entry) */
  exclude?: string[];
  /** Forward proxy/CA environment variables to stdio servers */
  forwardProxyEnv?: boolean;
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
  /** The transport that carried the session ('stdio' | 'streamable-http' | 'sse') */
  transport?: 'stdio' | 'streamable-http' | 'sse';
}

export interface McpToolResult {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
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
 * Connect to one MCP server (already expanded — no ${VAR} references) and
 * list its tools. Never throws: failures are reported in `error`, and
 * anything started is stopped.
 */
export async function introspectMcpServer(
  serverId: string,
  config: McpServerConfig,
  options?: Pick<IntrospectOptions, 'timeoutMs' | 'forwardProxyEnv'>,
): Promise<IntrospectionResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  let spec: McpConnectSpec;
  try {
    spec = connectSpecOf(config, options?.forwardProxyEnv);
  } catch (err) {
    return { serverId, tools: [], error: (err as Error).message };
  }

  let connection;
  try {
    connection = await connectMcp(spec, { timeoutMs });
  } catch (err) {
    return { serverId, tools: [], error: (err as Error).message };
  }

  try {
    const { client } = connection;
    const tools = client.getServerCapabilities()?.tools
      ? await listAllTools(client, { timeoutMs })
      : [];
    return {
      serverId,
      serverInfo: client.getServerVersion(),
      tools: tools as McpToolResult[],
      capabilities: client.getServerCapabilities() as Record<string, unknown> | undefined,
      instructions: client.getInstructions(),
      transport: connection.transport,
    };
  } catch (err) {
    const stderr = connection.stderrTail?.text().trim();
    return {
      serverId,
      tools: [],
      error: `tools/list failed: ${(err as Error).message}${stderr ? `; stderr: ${stderr.slice(-1000)}` : ''}`,
    };
  } finally {
    await connection.close().catch(() => {});
  }
}

/** The SDK connection spec for a config entry; throws for shapes it cannot use. */
function connectSpecOf(config: McpServerConfig, forwardProxyEnv?: boolean): McpConnectSpec {
  if (isRemoteConfig(config)) {
    return {
      transport: config.type === 'sse' ? 'sse' : config.type === undefined ? 'auto' : 'streamable-http',
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
    };
  }
  return {
    transport: 'stdio',
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    containerSandbox: config.containerSandbox,
    forwardProxyEnv,
  };
}

function isRemoteConfig(config: McpServerConfig): config is McpRemoteServerConfig {
  return typeof (config as McpRemoteServerConfig).url === 'string';
}

/**
 * Why an entry cannot be introspected, or null if its shape is usable.
 * Unknown transports (e.g. websocket) are reported, never guessed at.
 */
function entryProblem(config: unknown): string | null {
  if (!isObject(config)) return 'entry is not an object';
  const type = config.type;
  if (type !== undefined && !['stdio', 'http', 'streamable-http', 'sse'].includes(type as string)) {
    return `transport type "${String(type)}" is not supported (use stdio, http or sse)`;
  }
  if (type === 'stdio' || (type === undefined && config.url === undefined)) {
    if (typeof config.command !== 'string' || config.command === '') return 'has neither a "command" nor a "url"';
    if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every(a => typeof a === 'string'))) {
      return '"args" must be an array of strings';
    }
    if (config.env !== undefined && !isStringMap(config.env)) return '"env" must map names to strings';
    return null;
  }
  if (typeof config.url !== 'string' || config.url === '') return `type "${String(type)}" needs a "url"`;
  if (config.headers !== undefined && !isStringMap(config.headers)) return '"headers" must map names to strings';
  return null;
}

/** Expand ${VAR} references in every field Claude Code expands. */
function expandEntry(config: McpServerConfig, env: Record<string, string | undefined>): McpServerConfig {
  const x = (value: string) => expandEnvRefs(value, env);
  const xMap = (map?: Record<string, string>) =>
    map ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, x(v)])) : undefined;
  if (isRemoteConfig(config)) {
    return { ...config, url: x(config.url), ...(config.headers ? { headers: xMap(config.headers) } : {}) };
  }
  return {
    ...config,
    command: x(config.command),
    ...(config.args ? { args: config.args.map(x) } : {}),
    ...(config.env ? { env: xMap(config.env) } : {}),
    ...(config.cwd ? { cwd: x(config.cwd) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Config file introspection
// ---------------------------------------------------------------------------

/**
 * Parse an MCP config file and introspect each server to build manifests.
 * Throws only for an unreadable file or one without servers; entries that
 * cannot be introspected are reported through `log` and skipped.
 */
export async function introspectMcpConfigFile(
  configPath: string,
  options?: IntrospectOptions,
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

  return introspectMcpServers(parsed.mcpServers, options);
}

/**
 * Introspect every entry of an `mcpServers` object (see
 * introspectMcpConfigFile). Entries are introspected one at a time.
 */
export async function introspectMcpServers(
  servers: Record<string, unknown>,
  options?: IntrospectOptions,
): Promise<ProviderManifest[]> {
  const info = options?.log ?? ((line: string) => console.log(line));
  const warn = options?.log ?? ((line: string) => console.error(line));
  const env = options?.env ?? process.env;
  const excluded = new Set(options?.exclude ?? []);
  const manifests: ProviderManifest[] = [];

  for (const [serverId, raw] of Object.entries(servers)) {
    if (excluded.has(serverId)) continue;
    const problem = entryProblem(raw);
    if (problem) {
      warn(`  ${serverId}: skipped — ${problem}`);
      continue;
    }
    const config = raw as McpServerConfig;

    let expanded: McpServerConfig;
    try {
      expanded = expandEntry(config, env);
    } catch (err) {
      if (!(err instanceof MissingEnvVarError)) throw err;
      warn(`  ${serverId}: skipped — ${err.message}`);
      continue;
    }

    info(isRemoteConfig(expanded)
      ? `  Connecting to ${expanded.url} (server: ${serverId})...`
      : `  Spawning ${expanded.command} ${(expanded.args ?? []).join(' ')} (server: ${serverId})...`);

    try {
      const result = await introspectMcpServer(serverId, expanded, options);
      if (result.error) {
        warn(`  ${serverId}: FAILED — ${result.error}`);
        continue;
      }
      manifests.push(introspectionToManifest(result, launchOf(config, result.transport)));
      info(`  ${serverId}: ${result.tools.length} tools discovered`);
    } catch (err) {
      warn(`  ${serverId}: FAILED — ${(err as Error).message}`);
    }
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

  const serverConfig: McpServerConfig = { command: 'node', args: [fullEntryPath] };
  const result = await introspectMcpServer(serverId, serverConfig, options);

  if (result.error) {
    console.error(`  Introspection failed: ${result.error}`);
    return null;
  }

  console.log(`  ${serverName}: ${result.tools.length} tools discovered`);

  return introspectionToManifest(result, stdioLaunch(serverConfig));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The launch spec recorded for a server, from its config entry as written:
 * `${VAR}` references stay unexpanded (serve expands them from its own
 * environment) and environment variables are recorded by NAME only, so
 * values — tokens, keys — never leave the config file. A remote entry
 * records the transport that actually completed the handshake.
 */
function launchOf(config: McpServerConfig, transport?: IntrospectionResult['transport']): LaunchSpec {
  if (isRemoteConfig(config)) {
    return { transport: transport === 'sse' ? 'sse' : 'streamable-http', url: config.url };
  }
  return stdioLaunch(config);
}

function stdioLaunch(config: McpStdioServerConfig): LaunchSpec {
  return {
    transport: 'stdio',
    command: config.command,
    args: [...(config.args ?? [])],
    env: Object.keys(config.env ?? {}),
  };
}

/**
 * Convert an IntrospectionResult to a ProviderManifest, keeping the
 * upstream tool definition (title, inputSchema, outputSchema, annotations).
 */
function introspectionToManifest(result: IntrospectionResult, launch?: LaunchSpec): ProviderManifest {
  const tools: ToolDefinition[] = result.tools.map((t) => ({
    name: t.name,
    ...(typeof t.title === 'string' ? { title: t.title } : {}),
    description: t.description ?? t.name,
    inputSchema: (t.inputSchema as unknown as JSONSchemaType) ?? { type: 'object', properties: {} },
    ...(isObject(t.outputSchema) ? { outputSchema: t.outputSchema } : {}),
    ...(isObject(t.annotations) ? { annotations: t.annotations } : {}),
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
    ...(launch ? { launch } : {}),
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every(v => typeof v === 'string');
}
