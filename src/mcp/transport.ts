import type { ToolResult, TransportType, InferenceDelta } from '../core/types.js';
import { McpHttpTransport } from '../transport/mcp-client-transport.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * MCPTransport — bridges ToolProxy.execute to real tool calls.
 *
 * Supports three tiers of execution matching the runtime's streaming pipeline:
 *   1. executeInference — token-level deltas (no transport here produces them)
 *   2. executeStream    — chunk-level results
 *   3. execute          — single-shot call
 *
 * Each transport type (mcp, rest, local, grpc) gets its own execution
 * strategy. MCP endpoints are reached with the official SDK client
 * (McpHttpTransport: initialize handshake, session, Streamable HTTP with a
 * legacy SSE fallback), and every call has a timeout that cancels it
 * upstream. Stdio MCP servers in a compiled artifact are run by serve's
 * UpstreamPool, not by this class.
 */
export class MCPTransport {
  private endpoint: string | null;
  private transportType: TransportType;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private mcpClient: McpHttpTransport | null = null;

  constructor(options: TransportOptions) {
    this.endpoint = options.endpoint ?? null;
    this.transportType = options.transportType;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Close the MCP session, if one is open. */
  async close(): Promise<void> {
    const client = this.mcpClient;
    this.mcpClient = null;
    await client?.dispose();
  }

  /**
   * Execute a tool call via the appropriate transport.
   * Routes through MCP JSON-RPC, REST, local execution, or gRPC.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    switch (this.transportType) {
      case 'mcp':
        return this.executeMCP(toolName, args);
      case 'rest':
        return this.executeREST(toolName, args);
      case 'local':
        return this.executeLocal(toolName, args);
      case 'grpc':
        return this.executeGRPC(toolName, args);
      default:
        return {
          content: null,
          isError: true,
          metadata: { error: `Unknown transport: ${this.transportType}` },
        };
    }
  }

  /**
   * Stream a tool call, yielding chunk-level results.
   */
  async *executeStream(
    toolName: string,
    args: Record<string, unknown>,
  ): AsyncGenerator<ToolResult> {
    switch (this.transportType) {
      case 'mcp':
        yield* this.executeStreamMCP(toolName, args);
        break;
      case 'rest':
        yield* this.executeStreamREST(toolName, args);
        break;
      default: {
        // Fall back to single-shot for transports without streaming
        const result = await this.execute(toolName, args);
        yield result;
      }
    }
  }

  /**
   * Token-level inference streaming via SSE.
   */
  // eslint-disable-next-line require-yield
  async *executeInference(
    _toolName: string,
    _args: Record<string, unknown>,
  ): AsyncGenerator<InferenceDelta> {
    // MCP has no token-level tool output (the 0.x "X-MCP-Stream-Mode:
    // inference" request was not part of the protocol); callers fall back
    // to executeStream / execute.
    return;
  }

  // ---------------------------------------------------------------------------
  // MCP Transport — the SDK client over Streamable HTTP (or legacy SSE)
  // ---------------------------------------------------------------------------

  private async executeMCP(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!this.endpoint) {
      return {
        content: null,
        isError: true,
        metadata: { error: 'No MCP endpoint configured' },
      };
    }

    this.mcpClient ??= new McpHttpTransport({
      url: this.endpoint,
      headers: this.headers,
      timeoutMs: this.timeoutMs,
      initTimeoutMs: this.timeoutMs,
    });
    const output = await this.mcpClient.execute({ toolName, args });
    if (output.isError && output.content === null) {
      return {
        content: null,
        isError: true,
        metadata: { error: `MCP transport error: ${String(output.metadata?.error ?? 'unknown error')}`, ...output.metadata },
      };
    }
    return {
      content: output.content,
      isError: output.isError,
      ...(output.metadata ? { metadata: output.metadata } : {}),
    };
  }

  private async *executeStreamMCP(
    toolName: string,
    args: Record<string, unknown>,
  ): AsyncGenerator<ToolResult> {
    yield await this.executeMCP(toolName, args);
  }

  // ---------------------------------------------------------------------------
  // REST Transport — standard HTTP API calls
  // ---------------------------------------------------------------------------

  private async executeREST(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!this.endpoint) {
      return {
        content: null,
        isError: true,
        metadata: { error: 'No REST endpoint configured' },
      };
    }

    try {
      const url = `${this.endpoint.replace(/\/$/, '')}/${toolName}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const body = await response.json();
      return {
        content: body,
        isError: !response.ok,
        metadata: { statusCode: response.status },
      };
    } catch (err) {
      return {
        content: null,
        isError: true,
        metadata: { error: `REST transport error: ${(err as Error).message}` },
      };
    }
  }

  private async *executeStreamREST(
    toolName: string,
    args: Record<string, unknown>,
  ): AsyncGenerator<ToolResult> {
    if (!this.endpoint) {
      yield {
        content: null,
        isError: true,
        metadata: { error: 'No REST endpoint configured' },
      };
      return;
    }

    try {
      const url = `${this.endpoint.replace(/\/$/, '')}/${toolName}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        yield {
          content: body,
          isError: true,
          metadata: { statusCode: response.status },
        };
        return;
      }

      yield* parseSSEStream(response.body);
    } catch (err) {
      yield {
        content: null,
        isError: true,
        metadata: { error: `REST stream error: ${(err as Error).message}` },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Local Transport — in-process tool execution
  // ---------------------------------------------------------------------------

  private async executeLocal(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // Local tools are handled by the ToolProxy directly via schemaLoader
    // and any registered local handlers.
    const handler = localHandlers.get(toolName);
    if (handler) {
      try {
        return await handler(args);
      } catch (err) {
        return {
          content: null,
          isError: true,
          metadata: { error: `Local execution error: ${(err as Error).message}` },
        };
      }
    }

    return {
      content: null,
      isError: true,
      metadata: { error: `No local handler registered for ${toolName}` },
    };
  }

  // ---------------------------------------------------------------------------
  // gRPC Transport — stub for future implementation
  // ---------------------------------------------------------------------------

  private async executeGRPC(
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return {
      content: null,
      isError: true,
      metadata: { error: 'gRPC transport not yet implemented' },
    };
  }
}

// ---------------------------------------------------------------------------
// Transport options
// ---------------------------------------------------------------------------

export interface TransportOptions {
  transportType: TransportType;
  endpoint?: string;
  headers?: Record<string, string>;
  /** Per-call timeout in ms for mcp and rest calls (default 60 s); MCP calls are cancelled upstream */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Local handler registry
// ---------------------------------------------------------------------------

type LocalHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
const localHandlers: Map<string, LocalHandler> = new Map();

/** Register a local tool handler */
export function registerLocalHandler(toolName: string, handler: LocalHandler): void {
  localHandlers.set(toolName, handler);
}

/** Remove a local tool handler */
export function unregisterLocalHandler(toolName: string): boolean {
  return localHandlers.delete(toolName);
}

// ---------------------------------------------------------------------------
// Transport registry — maps provider endpoints to transport instances
// ---------------------------------------------------------------------------

const transportRegistry: Map<string, MCPTransport> = new Map();

/** Get or create a transport for a provider */
export function getTransport(providerId: string, options: TransportOptions): MCPTransport {
  const key = `${providerId}:${options.transportType}:${options.endpoint ?? 'local'}`;
  let transport = transportRegistry.get(key);
  if (!transport) {
    transport = new MCPTransport(options);
    transportRegistry.set(key, transport);
  }
  return transport;
}

/** Clear the transport registry (closing any open MCP sessions) */
export function clearTransports(): void {
  for (const transport of transportRegistry.values()) void transport.close();
  transportRegistry.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an SSE stream body into ToolResult chunks */
async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ToolResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const event = JSON.parse(data) as {
            jsonrpc?: string;
            id?: number;
            result?: { content: unknown[]; isError?: boolean };
            error?: { code: number; message: string };
            method?: string;
            params?: { content?: unknown; status?: string };
          };

          // Final result
          if (event.result) {
            yield {
              content: event.result.content,
              isError: event.result.isError ?? false,
            };
          }
          // Progress notification with content
          else if (event.params?.content !== undefined) {
            yield {
              content: event.params.content,
              isError: false,
              metadata: { streaming: true, status: event.params.status },
            };
          }
          // Error
          else if (event.error) {
            yield {
              content: null,
              isError: true,
              metadata: { error: event.error.message, code: event.error.code },
            };
          }
        } catch {
          // Skip malformed SSE events
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
