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
  /**
   * Sender identity for gating. Over the HTTP bridge this is the identity
   * of the credential the request presented, never a body field.
   */
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

/**
 * A verdict as the channel server reports it (the `permission-verdict`
 * event): who decided is part of the record. Never sent to the host.
 */
export interface RecordedPermissionVerdict extends PermissionVerdict {
  /** Authenticated identity of the approver (HTTP bridge), or the caller-supplied one */
  approver?: string;
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
  /**
   * Enable the HTTP bridge for inbound webhooks. Requires a credential
   * (httpBridgeSecret and/or httpBridgeTokens): start() refuses otherwise.
   */
  httpBridge?: boolean;
  /** HTTP bridge port (default: 3002; 0 picks a free port, see httpBridgeAddress) */
  httpBridgePort?: number;
  /** HTTP bridge host (default: 127.0.0.1) */
  httpBridgeHost?: string;
  /**
   * Shared secret for the HTTP bridge, presented as `X-Channel-Secret` or
   * `Authorization: Bearer`. Requests carrying it authenticate as
   * httpBridgeSecretIdentity.
   */
  httpBridgeSecret?: string;
  /** Identity of requests authenticated with httpBridgeSecret (default: "bridge") */
  httpBridgeSecretIdentity?: string;
  /**
   * Per-sender credentials: identity → token. A request presenting a token
   * authenticates as its identity, which is what the sender allowlist and
   * the permission approver list are checked against.
   */
  httpBridgeTokens?: Record<string, string>;
  /**
   * Identities allowed to submit permission verdicts over the bridge
   * (POST /permission). Empty or unset: every verdict is refused.
   */
  permissionApprovers?: string[];
  /**
   * Hostnames accepted in the Host header (DNS-rebinding defence). Default:
   * the loopback names for a loopback bind, the bind address otherwise; a
   * wildcard bind (0.0.0.0) requires this to be set.
   */
  httpBridgeAllowedHosts?: string[];
  /** Max HTTP request body in bytes (default: 256 KiB) */
  httpBridgeMaxBodyBytes?: number;
  /** Sender allowlist (identity strings) */
  senderAllowlist?: string[];
  /** Path to sender allowlist file (one sender per line) */
  senderAllowlistFile?: string;
  /** Max payload size in bytes (default: 64KB) */
  maxPayloadSize?: number;
  /**
   * Access-Control-Allow-Origin for the HTTP bridge. Omit/null to
   * disable CORS (the safe default for the 127.0.0.1 bind). Set to
   * '*' or a specific origin to opt in. Requests that carry an Origin
   * header are refused unless it matches (or this is '*').
   */
  httpBridgeCorsOrigin?: string | null;
}
