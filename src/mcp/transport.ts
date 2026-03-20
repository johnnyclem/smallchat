import type { ToolResult, TransportType, InferenceDelta } from '../core/types.js';

/**
 * MCPTransport — bridges ToolProxy.execute to real MCP tool calls.
 *
 * Supports three tiers of execution matching the runtime's streaming pipeline:
 *   1. executeInference — token-level deltas (SSE streams)
 *   2. executeStream    — chunk-level results
 *   3. execute          — single-shot JSON-RPC call
 *
 * Each transport type (mcp, rest, local, grpc) gets its own execution strategy.
 */
export class MCPTransport {
  private endpoint: string | null;
  private transportType: TransportType;
  private headers: Record<string, string>;

  constructor(options: TransportOptions) {
    this.endpoint = options.endpoint ?? null;
    this.transportType = options.transportType;
    this.headers = options.headers ?? {};
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
  async *executeInference(
    toolName: string,
    args: Record<string, unknown>,
  ): AsyncGenerator<InferenceDelta> {
    if (this.transportType !== 'mcp') {
      // Only MCP transport supports inference-level streaming
      return;
    }

    yield* this.executeInferenceMCP(toolName, args);
  }

  // ---------------------------------------------------------------------------
  // MCP Transport — JSON-RPC 2.0 over HTTP + SSE
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

    const rpcRequest = {
      jsonrpc: '2.0' as const,
      id: generateRequestId(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(rpcRequest),
      });

      if (!response.ok) {
        return {
          content: null,
          isError: true,
          metadata: { error: `MCP request failed: ${response.status} ${response.statusText}` },
        };
      }

      const rpcResponse = (await response.json()) as {
        jsonrpc: string;
        id: number;
        result?: { content: unknown[]; isError?: boolean };
        error?: { code: number; message: string };
      };

      if (rpcResponse.error) {
        return {
          content: null,
          isError: true,
          metadata: { error: rpcResponse.error.message, code: rpcResponse.error.code },
        };
      }

      return {
        content: rpcResponse.result?.content ?? null,
        isError: rpcResponse.result?.isError ?? false,
      };
    } catch (err) {
      return {
        content: null,
        isError: true,
        metadata: { error: `MCP transport error: ${(err as Error).message}` },
      };
    }
  }

  private async *executeStreamMCP(
    toolName: string,
    args: Record<string, unknown>,
  ): AsyncGenerator<ToolResult> {
    if (!this.endpoint) {
      yield {
        content: null,
        isError: true,
        metadata: { error: 'No MCP endpoint configured' },
      };
      return;
    }

    const rpcRequest = {
      jsonrpc: '2.0' as const,
      id: generateRequestId(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify(rpcRequest),
      });

      if (!response.ok) {
        yield {
          content: null,
          isError: true,
          metadata: { error: `MCP stream request failed: ${response.status}` },
        };
        return;
      }

      // If server responds with SSE, parse the event stream
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && response.body) {
        yield* parseSSEStream(response.body);
      } else {
        // Standard JSON-RPC response — yield as single chunk
        const rpcResponse = (await response.json()) as {
          result?: { content: unknown[]; isError?: boolean };
          error?: { code: number; message: string };
        };

        if (rpcResponse.error) {
          yield {
            content: null,
            isError: true,
            metadata: { error: rpcResponse.error.message },
          };
        } else {
          yield {
            content: rpcResponse.result?.content ?? null,
            isError: rpcResponse.result?.isError ?? false,
          };
        }
      }
    } catch (err) {
      yield {
        content: null,
        isError: true,
        metadata: { error: `MCP stream error: ${(err as Error).message}` },
      };
    }
  }

  private async *executeInferenceMCP(
    toolName: string,
    args: Record<string, unknown>,
  ): AsyncGenerator<InferenceDelta> {
    if (!this.endpoint) return;

    const rpcRequest = {
      jsonrpc: '2.0' as const,
      id: generateRequestId(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'X-MCP-Stream-Mode': 'inference',
          ...this.headers,
        },
        body: JSON.stringify(rpcRequest),
      });

      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;

          try {
            const event = JSON.parse(data) as {
              method?: string;
              params?: { delta?: { text?: string; finishReason?: string } };
            };

            if (event.params?.delta?.text !== undefined) {
              yield {
                text: event.params.delta.text,
                finishReason: (event.params.delta.finishReason as InferenceDelta['finishReason']) ?? null,
              };
            }
          } catch {
            // Skip malformed SSE events
          }
        }
      }
    } catch {
      // Inference stream failed — caller will fall back to chunk/single-shot
    }
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

/** Clear the transport registry */
export function clearTransports(): void {
  transportRegistry.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let requestCounter = 0;

function generateRequestId(): number {
  return ++requestCounter;
}

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
