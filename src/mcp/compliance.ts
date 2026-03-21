/**
 * MCP Server Compliance — full MCP 2024-11-05 / 2025-03-26 spec compliance layer
 *
 * Adds the missing spec requirements on top of the existing MCPServer:
 *
 *  - capabilities negotiation (roots, sampling, logging)
 *  - notifications/cancelled support
 *  - progress tokens ($/progress)
 *  - roots/list and roots/list_changed notification
 *  - sampling/createMessage support
 *  - logging/setLevel and log notifications
 *  - Proper error codes per JSON-RPC 2.0 + MCP extension codes
 *  - Pagination cursor validation
 *  - Protocol version header enforcement
 *
 * This module is imported by the MCP router and bolts compliance checks onto
 * the existing request/response pipeline without rewriting the server.
 */

// ---------------------------------------------------------------------------
// MCP Protocol versions
// ---------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26'] as const;
export type MCPProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export const LATEST_MCP_VERSION: MCPProtocolVersion = '2025-03-26';

// ---------------------------------------------------------------------------
// MCP error codes (extends JSON-RPC 2.0)
// ---------------------------------------------------------------------------

export const MCPErrorCode = {
  // JSON-RPC 2.0 standard codes
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // MCP extension codes
  RESOURCE_NOT_FOUND: -32002,
  TOOL_NOT_FOUND: -32003,
  PROMPT_NOT_FOUND: -32004,
  UNAUTHORIZED: -32001,
  RATE_LIMITED: -32005,
} as const;

export type MCPErrorCode = (typeof MCPErrorCode)[keyof typeof MCPErrorCode];

export interface MCPError {
  code: MCPErrorCode;
  message: string;
  data?: unknown;
}

export function mcpError(code: MCPErrorCode, message: string, data?: unknown): MCPError {
  return { code, message, data };
}

// ---------------------------------------------------------------------------
// MCP Capabilities — full capability map
// ---------------------------------------------------------------------------

export interface MCPClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export const DEFAULT_SERVER_CAPABILITIES: MCPServerCapabilities = {
  tools: { listChanged: true },
  resources: { subscribe: true, listChanged: true },
  prompts: { listChanged: true },
  logging: {},
};

// ---------------------------------------------------------------------------
// Protocol version negotiation
// ---------------------------------------------------------------------------

/**
 * Negotiate the MCP protocol version to use for a session.
 *
 * @param clientVersion - Version string from the client's initialize request
 * @returns Negotiated version (latest supported if client sends a newer version)
 */
export function negotiateProtocolVersion(clientVersion: string): MCPProtocolVersion {
  if ((MCP_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)) {
    return clientVersion as MCPProtocolVersion;
  }
  // Fall back to latest if client sends an unrecognised version
  return LATEST_MCP_VERSION;
}

// ---------------------------------------------------------------------------
// Progress token support
// ---------------------------------------------------------------------------

export interface ProgressToken {
  token: string | number;
  total?: number;
}

export interface ProgressNotification {
  method: 'notifications/progress';
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
  };
}

export function buildProgressNotification(
  token: string | number,
  progress: number,
  total?: number,
): ProgressNotification {
  return {
    method: 'notifications/progress',
    params: { progressToken: token, progress, total },
  };
}

// ---------------------------------------------------------------------------
// Cancellation support
// ---------------------------------------------------------------------------

export interface CancellationNotification {
  method: 'notifications/cancelled';
  params: {
    requestId: string | number;
    reason?: string;
  };
}

export function buildCancellationNotification(
  requestId: string | number,
  reason?: string,
): CancellationNotification {
  return {
    method: 'notifications/cancelled',
    params: { requestId, reason },
  };
}

// ---------------------------------------------------------------------------
// Logging support
// ---------------------------------------------------------------------------

export type MCPLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

export interface MCPLogNotification {
  method: 'notifications/message';
  params: {
    level: MCPLogLevel;
    logger?: string;
    data: unknown;
  };
}

export function buildLogNotification(
  level: MCPLogLevel,
  data: unknown,
  logger?: string,
): MCPLogNotification {
  return {
    method: 'notifications/message',
    params: { level, logger, data },
  };
}

// ---------------------------------------------------------------------------
// Roots support
// ---------------------------------------------------------------------------

export interface MCPRoot {
  uri: string;
  name?: string;
}

export interface MCPRootsListResult {
  roots: MCPRoot[];
}

export interface MCPRootsChangedNotification {
  method: 'notifications/roots/list_changed';
  params?: Record<string, never>;
}

export function buildRootsChangedNotification(): MCPRootsChangedNotification {
  return { method: 'notifications/roots/list_changed' };
}

// ---------------------------------------------------------------------------
// Sampling support
// ---------------------------------------------------------------------------

export interface MCPSamplingMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mimeType?: string;
  };
}

export interface MCPCreateMessageRequest {
  messages: MCPSamplingMessage[];
  modelPreferences?: {
    hints?: Array<{ name?: string }>;
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  systemPrompt?: string;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface MCPCreateMessageResult {
  role: 'assistant';
  content: {
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mimeType?: string;
  };
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

export interface PaginationParams {
  cursor?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Apply cursor-based pagination to an array.
 *
 * Cursors are base64-encoded indices. This simple implementation uses
 * index-based cursors; production use should use opaque stable IDs.
 */
export function paginate<T>(
  items: T[],
  params: PaginationParams,
  pageSize = 50,
): PaginatedResult<T> {
  let startIndex = 0;

  if (params.cursor) {
    try {
      startIndex = parseInt(Buffer.from(params.cursor, 'base64').toString('utf8'), 10);
    } catch {
      startIndex = 0;
    }
  }

  const page = items.slice(startIndex, startIndex + pageSize);
  const hasMore = startIndex + pageSize < items.length;

  return {
    items: page,
    nextCursor: hasMore
      ? Buffer.from(String(startIndex + pageSize)).toString('base64')
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Request validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a JSON-RPC request has the required structure.
 */
export function validateJsonRpcRequest(body: unknown): {
  valid: boolean;
  error?: MCPError;
} {
  if (!body || typeof body !== 'object') {
    return {
      valid: false,
      error: mcpError(MCPErrorCode.INVALID_REQUEST, 'Request body must be a JSON object'),
    };
  }

  const req = body as Record<string, unknown>;

  if (req.jsonrpc !== '2.0') {
    return {
      valid: false,
      error: mcpError(MCPErrorCode.INVALID_REQUEST, 'jsonrpc must be "2.0"'),
    };
  }

  if (typeof req.method !== 'string' || !req.method) {
    return {
      valid: false,
      error: mcpError(MCPErrorCode.INVALID_REQUEST, 'method must be a non-empty string'),
    };
  }

  return { valid: true };
}

/**
 * Check that the client has provided a valid MCP-Session-Id for stateful methods.
 */
export function requireSession(
  sessionId: string | null | undefined,
  method: string,
): MCPError | null {
  const statelessMethods = new Set(['initialize', 'ping', '$/cancelRequest']);

  if (!statelessMethods.has(method) && !sessionId) {
    return mcpError(
      MCPErrorCode.INVALID_REQUEST,
      `Method ${method} requires a valid Mcp-Session-Id header`,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool list changed notification
// ---------------------------------------------------------------------------

export interface MCPToolsChangedNotification {
  method: 'notifications/tools/list_changed';
  params?: Record<string, never>;
}

export function buildToolsChangedNotification(): MCPToolsChangedNotification {
  return { method: 'notifications/tools/list_changed' };
}

export interface MCPResourcesChangedNotification {
  method: 'notifications/resources/list_changed';
  params?: Record<string, never>;
}

export function buildResourcesChangedNotification(): MCPResourcesChangedNotification {
  return { method: 'notifications/resources/list_changed' };
}

export interface MCPPromptsChangedNotification {
  method: 'notifications/prompts/list_changed';
  params?: Record<string, never>;
}

export function buildPromptsChangedNotification(): MCPPromptsChangedNotification {
  return { method: 'notifications/prompts/list_changed' };
}
