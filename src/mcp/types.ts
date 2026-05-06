/**
 * MCP 2025-11-25 protocol types.
 *
 * Pinned compatibility contract: "MCP stable 2025-11-25"
 */

// ---------------------------------------------------------------------------
// Protocol version contract
// ---------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25'] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 core types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

// ---------------------------------------------------------------------------
// MCP error codes
// ---------------------------------------------------------------------------

export const MCP_ERROR = {
  // JSON-RPC standard
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // MCP-specific
  UNSUPPORTED_VERSION: -32000,
  SESSION_EXPIRED: -32001,
  CAPABILITY_MISMATCH: -32002,
  ALREADY_INITIALIZED: -32003,
  NOT_INITIALIZED: -32010,
  SESSION_CLOSED: -32011,
  INVALID_CURSOR: -32020,
  TOOL_NOT_FOUND: -32040,
  INSUFFICIENT_SCOPE: -32041,
  RESOURCE_NOT_FOUND: -32050,
  PROMPT_NOT_FOUND: -32060,
} as const;

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export type SessionStatus = 'active' | 'closed';

export interface McpSession {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;       // RFC3339
  lastSeenAt: string;      // RFC3339
  expiresAt: string;       // RFC3339
  clientName: string;
  clientVersion: string;
  selectedVersion: string;
  capabilities: McpClientCapabilities;
}

export interface McpClientCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  apps?: boolean;
  streaming?: {
    sse?: boolean;
    stdio?: boolean;
    tokenDeltas?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Registry item types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MCP Apps Extension types (io.modelcontextprotocol/ui, spec 2026-01-26)
// ---------------------------------------------------------------------------

/** UI resource metadata declared by MCP Apps tool authors */
export interface McpUiToolMeta {
  /** The ui:// resource URI for this tool's interactive view */
  resourceUri: string;
  /**
   * Which audiences may invoke this view.
   * "model" = AI only, "app" = UI only, both = unrestricted (default).
   */
  visibility?: Array<'model' | 'app'>;
}

/** CSP and permission metadata for a ui:// resource */
export interface McpUiResourceMeta {
  /** External domains the view may connect to (connect-src CSP) */
  allowedDomains?: string[];
  /** Browser capabilities the view requests */
  permissions?: Array<'camera' | 'microphone' | 'geolocation' | 'clipboard-write'>;
  /** Dedicated origin for OAuth callbacks or API allowlists */
  domain?: string;
  /** Visual hint: render with border/background (true) or borderless (false) */
  prefersBorder?: boolean;
}

export interface McpTool {
  id: string;
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tags?: string[];
  version?: string;
  /** MCP Apps metadata — present when this tool has an interactive view */
  _meta?: { ui?: McpUiToolMeta };
}

export interface McpResource {
  id: string;
  name: string;
  title: string;
  description: string;
  mimeType?: string;
  uri?: string;
  tags?: string[];
  version?: string;
}

export interface McpPrompt {
  id: string;
  name: string;
  title: string;
  description: string;
  parametersSchema?: Record<string, unknown>;
  template?: string | Record<string, unknown>;
  defaults?: Record<string, unknown>;
  tags?: string[];
  version?: string;
}

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

export type SseEventKind =
  | 'jsonrpc'
  | 'progress'
  | 'tools/list_changed'
  | 'resourceChanged'
  | 'stream';

export interface SseEnvelope {
  sessionId: string;
  ts: string;    // RFC3339
  seq: number;
  kind: SseEventKind;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Router options
// ---------------------------------------------------------------------------

export interface RouterOptions {
  serverName: string;
  serverVersion: string;
  sessionTtlMs: number;
}
