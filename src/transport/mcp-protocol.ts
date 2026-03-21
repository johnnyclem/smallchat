/**
 * MCP Protocol Handler — JSON-RPC 2.0 wire protocol for MCP servers.
 *
 * Implements the request/response framing needed to communicate with
 * MCP servers over any transport (stdio, SSE, HTTP).
 */

import { jsonRpcErrorToError, ToolExecutionError } from './errors.js';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MCP-specific message types
// ---------------------------------------------------------------------------

export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

// ---------------------------------------------------------------------------
// Request ID generator
// ---------------------------------------------------------------------------

let requestIdCounter = 0;

export function nextRequestId(): number {
  return ++requestIdCounter;
}

/** Reset counter (for testing) */
export function resetRequestIdCounter(): void {
  requestIdCounter = 0;
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/** Build a JSON-RPC initialize request */
export function buildInitializeRequest(): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: nextRequestId(),
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'smallchat',
        version: '0.1.0',
      },
    },
  };
}

/** Build a JSON-RPC initialized notification */
export function buildInitializedNotification(): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  };
}

/** Build a tools/list request */
export function buildToolsListRequest(): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: nextRequestId(),
    method: 'tools/list',
  };
}

/** Build a tools/call request */
export function buildToolCallRequest(
  toolName: string,
  args: Record<string, unknown>,
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: nextRequestId(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Parse a JSON-RPC response, throwing on error */
export function parseJsonRpcResponse<T = unknown>(data: unknown): T {
  const response = data as JsonRpcResponse;

  if (!response || response.jsonrpc !== '2.0') {
    throw new ToolExecutionError('Invalid JSON-RPC response', {
      code: 'INVALID_RESPONSE',
    });
  }

  if (response.error) {
    throw jsonRpcErrorToError(response.error.code, response.error.message);
  }

  return response.result as T;
}

/** Parse a line-delimited JSON-RPC message from a stdio buffer */
export function parseStdioMessages(buffer: string): {
  messages: (JsonRpcResponse | JsonRpcNotification)[];
  remaining: string;
} {
  const messages: (JsonRpcResponse | JsonRpcNotification)[] = [];
  const lines = buffer.split('\n');
  let remaining = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // If this is the last line and doesn't end with newline, it's incomplete
    if (i === lines.length - 1 && !buffer.endsWith('\n')) {
      remaining = lines[i];
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (parsed.jsonrpc === '2.0') {
        messages.push(parsed);
      }
    } catch {
      // Skip non-JSON lines (e.g., stderr leaking into stdout)
    }
  }

  return { messages, remaining };
}

/**
 * Encode a JSON-RPC message for stdio transport.
 * Each message is a single JSON line followed by a newline.
 */
export function encodeStdioMessage(message: JsonRpcRequest | JsonRpcNotification): string {
  return JSON.stringify(message) + '\n';
}
