/**
 * MCP Client Transport — connects to external MCP servers via Stdio or SSE.
 *
 * Implements ITransport for MCP protocol communication:
 *   - Stdio: Spawns a child process, communicates via JSON-RPC over stdin/stdout
 *   - SSE: Connects to an HTTP SSE endpoint for streaming MCP communication
 */

import type { ChildProcess } from 'node:child_process';
import type {
  ITransport,
  TransportInput,
  TransportOutput,
  McpStdioTransportConfig,
  McpSseTransportConfig,
  TransportKind,
} from './types.js';
import { spawnMcpProcess } from './container-sandbox.js';
import {
  buildInitializeRequest,
  buildInitializedNotification,
  buildToolCallRequest,
  buildToolsListRequest,
  encodeStdioMessage,
  parseStdioMessages,
  parseJsonRpcResponse,
  type JsonRpcResponse,
  type McpToolCallResult,
  type McpToolsListResult,
} from './mcp-protocol.js';
import { errorToOutput, ToolExecutionError } from './errors.js';
import { withTimeout } from './timeout.js';

let mcpTransportCounter = 0;

// ---------------------------------------------------------------------------
// MCP Stdio Transport
// ---------------------------------------------------------------------------

export class McpStdioTransport implements ITransport {
  readonly id: string;
  readonly type: TransportKind = 'mcp-stdio';

  private config: McpStdioTransportConfig;
  private process: ChildProcess | null = null;
  private buffer = '';
  private pendingRequests: Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason: unknown) => void;
  }> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: McpStdioTransportConfig) {
    this.id = `mcp-stdio-${++mcpTransportCounter}`;
    this.config = config;
  }

  async execute(input: TransportInput): Promise<TransportOutput> {
    try {
      await this.ensureInitialized();

      const request = buildToolCallRequest(input.toolName, input.args);
      const timeoutMs = input.timeoutMs ?? 30_000;

      const response = await withTimeout(
        () => this.sendRequest(request.id, request),
        timeoutMs,
        input.signal,
      );

      const result = parseJsonRpcResponse<McpToolCallResult>(response);

      return {
        content: result.content,
        isError: result.isError ?? false,
      };
    } catch (err) {
      return errorToOutput(err);
    }
  }

  /** List available tools from the MCP server */
  async listTools(): Promise<McpToolsListResult> {
    await this.ensureInitialized();
    const request = buildToolsListRequest();
    const response = await this.sendRequest(request.id, request);
    return parseJsonRpcResponse<McpToolsListResult>(response);
  }

  async dispose(): Promise<void> {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill('SIGTERM');

      // Give it a moment to exit gracefully
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 3000);

        this.process?.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      this.process = null;
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Transport disposed'));
    }
    this.pendingRequests.clear();
    this.initialized = false;
    this.initPromise = null;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    // Spawn the MCP server process (optionally inside a container sandbox)
    this.process = spawnMcpProcess({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      cwd: this.config.cwd,
      containerSandbox: this.config.containerSandbox,
    });

    // Handle stdout data
    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    // Handle process errors
    this.process.on('error', (err) => {
      for (const [, pending] of this.pendingRequests) {
        pending.reject(err);
      }
      this.pendingRequests.clear();
    });

    this.process.on('exit', (code) => {
      if (code !== 0) {
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error(`MCP server exited with code ${code}`));
        }
        this.pendingRequests.clear();
      }
    });

    // Send initialize request
    const initRequest = buildInitializeRequest();
    const timeoutMs = this.config.initTimeoutMs ?? 10_000;

    await withTimeout(
      async () => {
        const response = await this.sendRequest(initRequest.id, initRequest);
        parseJsonRpcResponse(response); // Validate response
      },
      timeoutMs,
    );

    // Send initialized notification
    const notification = buildInitializedNotification();
    this.process.stdin?.write(encodeStdioMessage(notification));

    this.initialized = true;
  }

  private sendRequest(id: number, request: { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> }): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new ToolExecutionError('MCP server stdin not writable', { code: 'TRANSPORT_ERROR' }));
        return;
      }

      this.pendingRequests.set(id, { resolve, reject });
      this.process.stdin.write(encodeStdioMessage(request));
    });
  }

  private processBuffer(): void {
    const { messages, remaining } = parseStdioMessages(this.buffer);
    this.buffer = remaining;

    for (const message of messages) {
      if ('id' in message && message.id !== undefined) {
        const pending = this.pendingRequests.get(message.id as number);
        if (pending) {
          this.pendingRequests.delete(message.id as number);
          pending.resolve(message as JsonRpcResponse);
        }
      }
      // Notifications are silently ignored for now
    }
  }
}

// ---------------------------------------------------------------------------
// MCP SSE Transport
// ---------------------------------------------------------------------------

export class McpSseTransport implements ITransport {
  readonly id: string;
  readonly type: TransportKind = 'mcp-sse';

  private config: McpSseTransportConfig;

  constructor(config: McpSseTransportConfig) {
    this.id = `mcp-sse-${++mcpTransportCounter}`;
    this.config = config;
  }

  async execute(input: TransportInput): Promise<TransportOutput> {
    try {
      const request = buildToolCallRequest(input.toolName, input.args);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.config.headers,
      };

      if (this.config.auth) {
        await this.config.auth.apply(headers);
      }

      const response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: input.signal,
      });

      if (!response.ok) {
        return {
          content: null,
          isError: true,
          metadata: {
            error: `MCP SSE request failed: ${response.status} ${response.statusText}`,
            statusCode: response.status,
          },
        };
      }

      const rpcResponse = (await response.json()) as JsonRpcResponse;
      const result = parseJsonRpcResponse<McpToolCallResult>(rpcResponse);

      return {
        content: result.content,
        isError: result.isError ?? false,
      };
    } catch (err) {
      return errorToOutput(err);
    }
  }

  async *executeStream(input: TransportInput): AsyncGenerator<TransportOutput> {
    try {
      const request = buildToolCallRequest(input.toolName, input.args);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...this.config.headers,
      };

      if (this.config.auth) {
        await this.config.auth.apply(headers);
      }

      const response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: input.signal,
      });

      if (!response.ok || !response.body) {
        yield {
          content: null,
          isError: true,
          metadata: { error: `MCP SSE stream failed: ${response.status}`, statusCode: response.status },
        };
        return;
      }

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
          if (!data || data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            if (event.result) {
              yield {
                content: event.result.content ?? event.result,
                isError: event.result.isError ?? false,
              };
            } else if (event.params?.content !== undefined) {
              yield {
                content: event.params.content,
                isError: false,
                metadata: { streaming: true },
              };
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (err) {
      yield errorToOutput(err);
    }
  }

  async dispose(): Promise<void> {
    // SSE transport is stateless — nothing to dispose
  }
}
