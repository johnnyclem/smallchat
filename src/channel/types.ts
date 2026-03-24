/**
 * Channel types — Claude Code channel protocol support.
 *
 * Defines the capability model, event types, and permission relay structures
 * for Claude Code's experimental channel notification protocol.
 *
 * Notification methods:
 *   notifications/claude/channel                  — inbound event
 *   notifications/claude/channel/permission_request — permission relay from host
 *   notifications/claude/channel/permission        — verdict sent back to host
 *
 * Capabilities:
 *   experimental["claude/channel"]                — required for a channel
 *   experimental["claude/channel/permission"]     — opt-in for permission relay
 */

// ---------------------------------------------------------------------------
// Channel capabilities
// ---------------------------------------------------------------------------

export interface ChannelCapabilities {
  /** Whether this provider is a channel */
  isChannel: boolean;
  /** Whether the provider supports permission relay */
  permissionRelay: boolean;
  /** Whether the channel has a reply tool (two-way) */
  twoWay: boolean;
  /** Name of the reply tool if two-way (default: "reply") */
  replyToolName?: string;
  /** Channel-specific system prompt instructions */
  instructions?: string;
}

/**
 * MCP experimental capabilities object for channel servers.
 */
export interface ChannelExperimentalCapabilities {
  'claude/channel': Record<string, never>;
  'claude/channel/permission'?: Record<string, never>;
}

// ---------------------------------------------------------------------------
// Channel events (notifications/claude/channel)
// ---------------------------------------------------------------------------

/**
 * Inbound channel event — the payload sent via notifications/claude/channel.
 */
export interface ChannelEvent {
  /** Channel source identifier */
  channel: string;
  /** Event content (text message, notification, etc.) */
  content: string;
  /** Structured metadata — keys must be identifier-only (letters/digits/underscore) */
  meta?: Record<string, string>;
  /** Sender identity for gating */
  sender?: string;
  /** ISO 8601 timestamp */
  timestamp?: string;
}

/**
 * Serialized form of a channel event for the MCP notification payload.
 */
export interface ChannelNotificationParams {
  channel: string;
  content: string;
  meta?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Permission relay
// ---------------------------------------------------------------------------

/**
 * Permission request received from the MCP host (Claude Code).
 * Sent via notifications/claude/channel/permission_request.
 */
export interface PermissionRequest {
  /** Unique request ID: 5 lowercase letters excluding 'l' — regex: [a-km-z]{5} */
  request_id: string;
  /** Human-readable description of what is being requested */
  description: string;
  /** Tool name being requested */
  tool_name?: string;
  /** Tool arguments */
  tool_arguments?: Record<string, unknown>;
}

/**
 * Permission verdict sent back to the host.
 * Sent via notifications/claude/channel/permission.
 */
export interface PermissionVerdict {
  /** The request_id from the original permission_request */
  request_id: string;
  /** Whether to allow or deny */
  behavior: 'allow' | 'deny';
}

// ---------------------------------------------------------------------------
// Channel provider metadata (for compiled artifacts)
// ---------------------------------------------------------------------------

/**
 * Extended provider metadata in the compiled artifact.
 * Added to providers that are identified as channels.
 */
export interface ChannelProviderMeta {
  /** Whether this provider is a channel */
  isChannel: boolean;
  /** Whether the channel is two-way (has reply tool) */
  twoWay: boolean;
  /** Whether permission relay is supported */
  permissionRelay: boolean;
  /** Name of the reply tool (if two-way) */
  replyToolName?: string;
  /** Channel-specific instructions text */
  instructions?: string;
}

// ---------------------------------------------------------------------------
// Channel server configuration
// ---------------------------------------------------------------------------

export interface ChannelServerConfig {
  /** Channel name/identifier */
  channelName: string;
  /** Enable two-way mode with reply tool */
  twoWay?: boolean;
  /** Reply tool name (default: "reply") */
  replyToolName?: string;
  /** Enable permission relay */
  permissionRelay?: boolean;
  /** Channel instructions for the LLM */
  instructions?: string;
  /** Enable HTTP bridge for inbound webhooks */
  httpBridge?: boolean;
  /** HTTP bridge port (default: 3002) */
  httpBridgePort?: number;
  /** HTTP bridge host (default: 127.0.0.1) */
  httpBridgeHost?: string;
  /** Shared secret for HTTP bridge authentication */
  httpBridgeSecret?: string;
  /** Sender allowlist (identity strings) */
  senderAllowlist?: string[];
  /** Path to sender allowlist file (one sender per line) */
  senderAllowlistFile?: string;
  /** Max payload size in bytes (default: 64KB) */
  maxPayloadSize?: number;
}
