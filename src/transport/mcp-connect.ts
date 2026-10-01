/**
 * Outbound MCP connections — the one place smallchat starts or reaches an
 * MCP server as a client. Config introspection (`compile`, `setup`,
 * `dream`), McpStdioTransport / McpHttpTransport, MCPTransport and serve's
 * UpstreamPool all connect through here, on the official SDK client:
 *
 *   - the initialize handshake, protocol version negotiation, the
 *     Accept / Mcp-Session-Id / MCP-Protocol-Version headers and sessions
 *     are the SDK's;
 *   - per-request timeouts and AbortSignals send notifications/cancelled;
 *   - stdio servers are spawned with buildMcpSpawnSpec's environment (via
 *     cross-spawn, so `npx` resolves on Windows), and their stderr is
 *     drained into a bounded tail, never left to fill the pipe;
 *   - remote servers use Streamable HTTP, legacy HTTP+SSE, or 'auto'
 *     (Streamable HTTP first, then SSE — the spec's fallback for servers
 *     that predate Streamable HTTP).
 */

import type { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpSpawnSpec, type SpawnMcpProcessOptions } from './container-sandbox.js';
import { PACKAGE_VERSION } from '../core/version.js';

export const DEFAULT_CLIENT_INFO = { name: 'smallchat', version: PACKAGE_VERSION };

/** Where and how to reach one MCP server. */
export type McpConnectSpec =
  | ({ transport: 'stdio' } & SpawnMcpProcessOptions)
  | {
      transport: 'streamable-http' | 'sse' | 'auto';
      url: string;
      /** Extra request headers (e.g. Authorization) */
      headers?: Record<string, string>;
      /** Custom fetch (e.g. one that adds a refreshed token to every request) */
      fetch?: FetchLike;
    };

export interface McpConnectOptions {
  clientInfo?: { name: string; version: string };
  /** Timeout for the initialize handshake (default 30 s) */
  timeoutMs?: number;
  /**
   * stdio servers' stderr: 'tail' (default) drains it into `stderrTail`;
   * 'inherit' passes it through to ours; 'ignore' discards it.
   */
  stderr?: 'tail' | 'inherit' | 'ignore';
  /** Bytes of stderr kept for diagnostics (default 16 KiB) */
  stderrTailBytes?: number;
}

/** A connected client and the transport kind that carried the handshake. */
export interface McpConnection {
  client: Client;
  transport: 'stdio' | 'streamable-http' | 'sse';
  /** The end of the server's stderr (stdio with stderr 'tail'), for error messages */
  stderrTail: StderrTail | null;
  /** The stdio server's process id, while it runs */
  readonly pid: number | null;
  close(): Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Connect an SDK client to an MCP server and complete initialize. Rejects
 * (after stopping anything it started) if the server cannot be started or
 * reached or the handshake fails; the error message includes the end of a
 * stdio server's stderr.
 */
export async function connectMcp(spec: McpConnectSpec, options: McpConnectOptions = {}): Promise<McpConnection> {
  if (spec.transport === 'stdio') return connectStdio(spec, options);
  const url = new URL(spec.url);
  if (spec.transport !== 'auto') return connectRemote(url, spec.transport, spec, options);
  try {
    return await connectRemote(url, 'streamable-http', spec, options);
  } catch (err) {
    // A server that predates Streamable HTTP answers the initialize POST
    // with a 4xx; try the legacy HTTP+SSE transport at the same URL.
    if (!isHttpClientError(err)) throw err;
    try {
      return await connectRemote(url, 'sse', spec, options);
    } catch (sseErr) {
      throw new Error(`${(err as Error).message} (legacy SSE fallback: ${(sseErr as Error).message})`);
    }
  }
}

async function connectStdio(
  spec: { transport: 'stdio' } & SpawnMcpProcessOptions,
  options: McpConnectOptions,
): Promise<McpConnection> {
  const launch = buildMcpSpawnSpec(spec);
  const stderrMode = options.stderr ?? 'tail';
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: launch.env,
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    stderr: stderrMode === 'tail' ? 'pipe' : stderrMode,
  });
  const tail = stderrMode === 'tail' ? new StderrTail(options.stderrTailBytes) : null;
  if (tail && transport.stderr) tail.drain(transport.stderr as Readable);

  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, { capabilities: {} });
  await handshake(client, transport, options, tail, `"${spec.command}"`);
  return {
    client,
    transport: 'stdio',
    stderrTail: tail,
    get pid() { return transport.pid; },
    close: () => client.close(),
  };
}

async function connectRemote(
  url: URL,
  kind: 'streamable-http' | 'sse',
  spec: { headers?: Record<string, string>; fetch?: FetchLike },
  options: McpConnectOptions,
): Promise<McpConnection> {
  const opts = {
    ...(spec.headers ? { requestInit: { headers: spec.headers } } : {}),
    ...(spec.fetch ? { fetch: spec.fetch } : {}),
  };
  const transport = kind === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, { capabilities: {} });
  await handshake(client, transport, options, null, url.href);
  return {
    client,
    transport: kind,
    stderrTail: null,
    pid: null,
    close: () => client.close(),
  };
}

async function handshake(
  client: Client,
  transport: Transport,
  options: McpConnectOptions,
  tail: StderrTail | null,
  what: string,
): Promise<void> {
  const timeout = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  // A stdio server that exits before answering never sends a response;
  // fail the handshake as soon as its process is gone. (Remote transports
  // reject connect() themselves, with the HTTP status the SSE fallback needs.)
  let closedEarly: (() => void) | undefined;
  const closed = new Promise<never>((_, reject) => {
    closedEarly = () => reject(new Error(`${what} exited before completing initialize`));
  });
  closed.catch(() => {});
  if (transport instanceof StdioClientTransport) client.onclose = () => closedEarly?.();
  try {
    await Promise.race([client.connect(transport, { timeout }), closed]);
  } catch (err) {
    // Stop whatever was started (a half-initialized stdio server keeps running otherwise).
    await client.close().catch(() => {});
    // Let the last stderr chunks of an exited server reach the tail.
    await new Promise(r => setImmediate(r));
    throw new Error(describeConnectError(err, what, timeout, tail), { cause: err });
  } finally {
    client.onclose = undefined;
  }
}

function describeConnectError(err: unknown, what: string, timeoutMs: number, tail: StderrTail | null): string {
  let message: string;
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    message = `${what} did not complete initialize within ${timeoutMs}ms`;
  } else {
    message = (err as Error)?.message ?? String(err);
  }
  const stderr = tail?.text().trim();
  return stderr ? `${message}; stderr: ${stderr.slice(-1000)}` : message;
}

function isHttpClientError(err: unknown): boolean {
  const cause = (err as { cause?: unknown })?.cause ?? err;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === 'number' && code >= 400 && code < 500;
}

/**
 * Every tool the server lists, following nextCursor until the last page.
 * Stops on a repeated cursor (a server bug that would otherwise loop).
 */
export async function listAllTools(
  client: Client,
  options: { timeoutMs?: number; maxPages?: number; signal?: AbortSignal } = {},
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  const maxPages = options.maxPages ?? 1000;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await client.listTools(cursor !== undefined ? { cursor } : undefined, {
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined) return tools;
    if (seen.has(cursor)) throw new Error(`tools/list returned cursor "${cursor}" twice`);
    seen.add(cursor);
  }
  throw new Error(`tools/list did not finish within ${maxPages} pages`);
}

/** Whether an error from a client request is the SDK's request timeout. */
export function isMcpTimeout(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.RequestTimeout;
}

/**
 * The last `maxBytes` of a stream, read continuously so the writer never
 * blocks on a full pipe.
 */
export class StderrTail {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes = 16 * 1024) {}

  drain(stream: Readable): void {
    stream.on('data', (chunk: Buffer | string) => this.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    stream.on('error', () => {});
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
    if (this.size > this.maxBytes) {
      const only = this.chunks[0];
      this.chunks[0] = only.subarray(only.length - this.maxBytes);
      this.size = this.chunks[0].length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }
}

// ---------------------------------------------------------------------------
// ${VAR} expansion (Claude Code's .mcp.json semantics)
// ---------------------------------------------------------------------------

/** A ${VAR} reference with no value and no default. */
export class MissingEnvVarError extends Error {
  constructor(readonly names: string[]) {
    super(`environment variable${names.length === 1 ? '' : 's'} ${names.join(', ')} not set`);
    this.name = 'MissingEnvVarError';
  }
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand `${VAR}` and `${VAR:-default}` the way Claude Code expands
 * .mcp.json entries. Throws MissingEnvVarError naming every variable that
 * is unset and has no default.
 */
export function expandEnvRefs(value: string, env: Record<string, string | undefined>): string {
  const missing: string[] = [];
  const expanded = value.replace(ENV_REF, (_, name: string, fallback: string | undefined) => {
    const found = env[name];
    if (found !== undefined) return found;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return '';
  });
  if (missing.length > 0) throw new MissingEnvVarError([...new Set(missing)]);
  return expanded;
}
