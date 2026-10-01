/**
 * MCP Client Transports — ITransport over the official MCP SDK client.
 *
 *   - McpStdioTransport: spawns the server (optionally in a container
 *     sandbox) and speaks MCP over its stdin/stdout. Its stderr is drained
 *     into a bounded tail (stderrTail()), so a chatty server never blocks.
 *   - McpHttpTransport: reaches a remote server over Streamable HTTP, the
 *     legacy HTTP+SSE transport, or 'auto' (Streamable HTTP, falling back
 *     to SSE).
 *   - McpSseTransport: the 0.x name of McpHttpTransport (deprecated).
 *
 * Connections are made through connectMcp(), so the initialize handshake,
 * protocol version negotiation, sessions and headers are the SDK's. They
 * open lazily on the first call. A failed start, or a connection that
 * closes, is never cached: the next call connects again, after a backoff
 * that doubles on consecutive failures (restartBackoffMs, at most 30 s).
 * A call that times out or is aborted is cancelled upstream
 * (notifications/cancelled) and the connection stays usable.
 */

import { CallToolResultSchema, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  ITransport,
  TransportInput,
  TransportOutput,
  McpStdioTransportConfig,
  McpHttpTransportConfig,
  McpSseTransportConfig,
  TransportKind,
} from './types.js';
import { connectMcp, listAllTools, isMcpTimeout, type McpConnectSpec, type McpConnection } from './mcp-connect.js';
import { errorToOutput, jsonRpcErrorToError, ToolExecutionError, TransportTimeoutError } from './errors.js';

let mcpTransportCounter = 0;

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const MAX_RESTART_BACKOFF_MS = 30_000;

/** Shared connection management for the SDK-backed MCP transports. */
abstract class SdkClientTransport implements ITransport {
  abstract readonly id: string;
  abstract readonly type: TransportKind;

  private connection: Promise<McpConnection> | null = null;
  private live: McpConnection | null = null;
  private failures = 0;
  private retryAt = 0;
  private lastFailure = '';

  protected constructor(
    private readonly timeouts: { initTimeoutMs?: number; timeoutMs?: number; restartBackoffMs?: number },
  ) {}

  /** Where to connect; called for every (re)connection. */
  protected abstract spec(): McpConnectSpec;

  async execute(input: TransportInput): Promise<TransportOutput> {
    const timeoutMs = input.timeoutMs ?? this.timeouts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      const { client } = await this.connect();
      const result = await client.callTool(
        { name: input.toolName, arguments: input.args },
        CallToolResultSchema,
        { timeout: timeoutMs, ...(input.signal ? { signal: input.signal } : {}) },
      ) as CallToolResult;
      return {
        content: result.content,
        isError: result.isError === true,
        ...(result.structuredContent !== undefined ? { metadata: { structuredContent: result.structuredContent } } : {}),
      };
    } catch (err) {
      return callErrorToOutput(err, timeoutMs, input.signal);
    }
  }

  async *executeStream(input: TransportInput): AsyncGenerator<TransportOutput> {
    yield await this.execute(input);
  }

  /** Every tool the server lists (all tools/list pages). */
  async listTools(): Promise<{ tools: Tool[] }> {
    const { client } = await this.connect();
    const tools = await listAllTools(client, { timeoutMs: this.timeouts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS });
    return { tools };
  }

  /** Close the connection (and stop a stdio server). A later call reconnects. */
  async dispose(): Promise<void> {
    const pending = this.connection;
    this.connection = null;
    this.live = null;
    if (pending) {
      try {
        await (await pending).close();
      } catch {
        // never connected, or already closed
      }
    }
  }

  protected current(): McpConnection | null {
    return this.live;
  }

  /** Called with every new connection. */
  protected connected(_connection: McpConnection): void {}

  private connect(): Promise<McpConnection> {
    if (this.connection) return this.connection;
    const wait = this.retryAt - Date.now();
    if (wait > 0) {
      return Promise.reject(new ToolExecutionError(
        `MCP server unavailable (next attempt in ${wait}ms): ${this.lastFailure}`,
        { code: 'TRANSPORT_ERROR', retryable: true },
      ));
    }
    const pending = connectMcp(this.spec(), {
      timeoutMs: this.timeouts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
    }).then(
      (connection) => {
        this.failures = 0;
        this.retryAt = 0;
        this.live = connection;
        this.connected(connection);
        connection.client.onclose = () => {
          // The server exited or the session ended: reconnect on the next call.
          if (this.live === connection) {
            this.live = null;
            this.connection = null;
          }
        };
        return connection;
      },
      (err: Error) => {
        this.failures++;
        const backoff = this.timeouts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
        this.retryAt = Date.now() + Math.min(backoff * 2 ** (this.failures - 1), MAX_RESTART_BACKOFF_MS);
        this.lastFailure = err.message;
        if (this.connection === pending) this.connection = null;
        throw new ToolExecutionError(err.message, { code: 'TRANSPORT_ERROR', retryable: true, cause: err });
      },
    );
    this.connection = pending;
    return pending;
  }
}

// ---------------------------------------------------------------------------
// MCP Stdio Transport
// ---------------------------------------------------------------------------

export class McpStdioTransport extends SdkClientTransport {
  readonly id: string;
  readonly type: TransportKind = 'mcp-stdio';

  private config: McpStdioTransportConfig;
  private lastTail: McpConnection['stderrTail'] = null;

  constructor(config: McpStdioTransportConfig) {
    super({ initTimeoutMs: config.initTimeoutMs, timeoutMs: config.timeoutMs, restartBackoffMs: config.restartBackoffMs });
    this.id = `mcp-stdio-${++mcpTransportCounter}`;
    this.config = config;
  }

  /** The end of the server's stderr (current or last process), for diagnostics. */
  stderrTail(): string {
    return (this.current()?.stderrTail ?? this.lastTail)?.text() ?? '';
  }

  /** The running server's process id, or null. */
  get pid(): number | null {
    return this.current()?.pid ?? null;
  }

  protected spec(): McpConnectSpec {
    return {
      transport: 'stdio',
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      cwd: this.config.cwd,
      containerSandbox: this.config.containerSandbox,
      inheritEnv: this.config.inheritEnv,
      forwardProxyEnv: this.config.forwardProxyEnv,
    };
  }

  protected override connected(connection: McpConnection): void {
    this.lastTail = connection.stderrTail;
  }
}

// ---------------------------------------------------------------------------
// MCP HTTP Transport (Streamable HTTP, legacy SSE)
// ---------------------------------------------------------------------------

export class McpHttpTransport extends SdkClientTransport {
  readonly id: string;
  readonly type: TransportKind = 'mcp-http';

  private config: McpHttpTransportConfig;

  constructor(config: McpHttpTransportConfig, idPrefix = 'mcp-http') {
    super({ initTimeoutMs: config.initTimeoutMs, timeoutMs: config.timeoutMs, restartBackoffMs: config.restartBackoffMs });
    this.id = `${idPrefix}-${++mcpTransportCounter}`;
    this.config = config;
  }

  protected spec(): McpConnectSpec {
    const auth = this.config.auth;
    return {
      transport: this.config.transport ?? 'auto',
      url: this.config.url,
      ...(this.config.headers ? { headers: this.config.headers } : {}),
      // Apply the auth strategy to every request, so refreshed tokens are used.
      ...(auth
        ? {
            fetch: async (url: string | URL, init?: RequestInit) => {
              const headers: Record<string, string> = {};
              new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
              await auth.apply(headers);
              return fetch(url, { ...init, headers });
            },
          }
        : {}),
    };
  }
}

/**
 * @deprecated Use McpHttpTransport. Kept so 0.x code compiles; it now
 * speaks real MCP (handshake, sessions, Streamable HTTP with SSE fallback).
 */
export class McpSseTransport extends McpHttpTransport {
  override readonly type: TransportKind = 'mcp-sse';

  constructor(config: McpSseTransportConfig) {
    super(config, 'mcp-sse');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callErrorToOutput(err: unknown, timeoutMs: number, signal?: AbortSignal): TransportOutput {
  if (isMcpTimeout(err)) return errorToOutput(new TransportTimeoutError(timeoutMs));
  if (signal?.aborted) {
    return errorToOutput(new ToolExecutionError('Request aborted', { code: 'ABORTED', cause: err instanceof Error ? err : undefined }));
  }
  if (err instanceof McpError) return errorToOutput(jsonRpcErrorToError(err.code, err.message));
  return errorToOutput(err);
}
