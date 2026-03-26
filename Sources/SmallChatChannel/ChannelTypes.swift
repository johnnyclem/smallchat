// MARK: - Channel Types
// Channel-specific types for the Claude Code channel notification protocol.

import Foundation
import SmallChatCore

// MARK: - Channel Capabilities

/// Describes the capabilities of a channel provider.
public struct ChannelCapabilities: Sendable, Codable, Equatable {
    /// Whether this provider is a channel.
    public let isChannel: Bool
    /// Whether the provider supports permission relay.
    public let permissionRelay: Bool
    /// Whether the channel has a reply tool (two-way).
    public let twoWay: Bool
    /// Name of the reply tool if two-way (default: "reply").
    public let replyToolName: String?
    /// Channel-specific system prompt instructions.
    public let instructions: String?

    public init(
        isChannel: Bool,
        permissionRelay: Bool = false,
        twoWay: Bool = false,
        replyToolName: String? = nil,
        instructions: String? = nil
    ) {
        self.isChannel = isChannel
        self.permissionRelay = permissionRelay
        self.twoWay = twoWay
        self.replyToolName = replyToolName
        self.instructions = instructions
    }
}

/// MCP experimental capabilities object for channel servers.
public struct ChannelExperimentalCapabilities: Sendable, Codable, Equatable {
    /// Presence of the channel capability (always present for channel servers).
    public let claudeChannel: Bool
    /// Presence of the permission relay capability.
    public let claudeChannelPermission: Bool

    public init(claudeChannel: Bool = true, claudeChannelPermission: Bool = false) {
        self.claudeChannel = claudeChannel
        self.claudeChannelPermission = claudeChannelPermission
    }

    /// Build the experimental capabilities dictionary for MCP initialize response.
    public func toDictionary() -> [String: [String: String]] {
        var result: [String: [String: String]] = [
            "claude/channel": [:]
        ]
        if claudeChannelPermission {
            result["claude/channel/permission"] = [:]
        }
        return result
    }
}

// MARK: - Channel Event

/// Inbound channel event -- the payload sent via notifications/claude/channel.
public struct ChannelEvent: Sendable, Codable, Equatable {
    /// Channel source identifier.
    public let channel: String
    /// Event content (text message, notification, etc.).
    public let content: String
    /// Structured metadata -- keys must be identifier-only (letters/digits/underscore).
    public let meta: [String: String]?
    /// Sender identity for gating.
    public let sender: String?
    /// ISO 8601 timestamp.
    public let timestamp: String?

    public init(
        channel: String,
        content: String,
        meta: [String: String]? = nil,
        sender: String? = nil,
        timestamp: String? = nil
    ) {
        self.channel = channel
        self.content = content
        self.meta = meta
        self.sender = sender
        self.timestamp = timestamp
    }
}

/// Serialized form of a channel event for the MCP notification payload.
public struct ChannelNotificationParams: Sendable, Codable, Equatable {
    public let channel: String
    public let content: String
    public let meta: [String: String]?

    public init(channel: String, content: String, meta: [String: String]? = nil) {
        self.channel = channel
        self.content = content
        self.meta = meta
    }
}

// MARK: - Permission Relay

/// Permission request received from the MCP host (Claude Code).
/// Sent via notifications/claude/channel/permission_request.
public struct PermissionRequest: Sendable, Codable, Equatable {
    /// Unique request ID: 5 lowercase letters excluding 'l' -- regex: [a-km-z]{5}.
    public let requestId: String
    /// Human-readable description of what is being requested.
    public let description: String
    /// Tool name being requested.
    public let toolName: String?
    /// Tool arguments.
    public let toolArguments: [String: AnyCodableValue]?

    public init(
        requestId: String,
        description: String,
        toolName: String? = nil,
        toolArguments: [String: AnyCodableValue]? = nil
    ) {
        self.requestId = requestId
        self.description = description
        self.toolName = toolName
        self.toolArguments = toolArguments
    }

    private enum CodingKeys: String, CodingKey {
        case requestId = "request_id"
        case description
        case toolName = "tool_name"
        case toolArguments = "tool_arguments"
    }
}

/// Permission verdict sent back to the host.
/// Sent via notifications/claude/channel/permission.
public struct PermissionVerdict: Sendable, Codable, Equatable {
    /// The request_id from the original permission_request.
    public let requestId: String
    /// Whether to allow or deny.
    public let behavior: PermissionBehavior

    public init(requestId: String, behavior: PermissionBehavior) {
        self.requestId = requestId
        self.behavior = behavior
    }

    private enum CodingKeys: String, CodingKey {
        case requestId = "request_id"
        case behavior
    }
}

/// Permission behavior: allow or deny.
public enum PermissionBehavior: String, Sendable, Codable, Equatable {
    case allow
    case deny
}

// MARK: - Channel Provider Metadata

/// Extended provider metadata for compiled artifacts.
/// Added to providers that are identified as channels.
public struct ChannelProviderMeta: Sendable, Codable, Equatable {
    /// Whether this provider is a channel.
    public let isChannel: Bool
    /// Whether the channel is two-way (has reply tool).
    public let twoWay: Bool
    /// Whether permission relay is supported.
    public let permissionRelay: Bool
    /// Name of the reply tool (if two-way).
    public let replyToolName: String?
    /// Channel-specific instructions text.
    public let instructions: String?

    public init(
        isChannel: Bool,
        twoWay: Bool = false,
        permissionRelay: Bool = false,
        replyToolName: String? = nil,
        instructions: String? = nil
    ) {
        self.isChannel = isChannel
        self.twoWay = twoWay
        self.permissionRelay = permissionRelay
        self.replyToolName = replyToolName
        self.instructions = instructions
    }
}

// MARK: - Channel Server Configuration

/// Configuration for a channel server instance.
public struct ChannelServerConfig: Sendable, Codable, Equatable {
    /// Channel name/identifier.
    public let channelName: String
    /// Enable two-way mode with reply tool.
    public let twoWay: Bool
    /// Reply tool name (default: "reply").
    public let replyToolName: String
    /// Enable permission relay.
    public let permissionRelay: Bool
    /// Channel instructions for the LLM.
    public let instructions: String?
    /// Enable HTTP bridge for inbound webhooks.
    public let httpBridge: Bool
    /// HTTP bridge port (default: 3002).
    public let httpBridgePort: Int
    /// HTTP bridge host (default: 127.0.0.1).
    public let httpBridgeHost: String
    /// Shared secret for HTTP bridge authentication.
    public let httpBridgeSecret: String?
    /// Sender allowlist (identity strings).
    public let senderAllowlist: [String]?
    /// Path to sender allowlist file (one sender per line).
    public let senderAllowlistFile: String?
    /// Max payload size in bytes (default: 64KB).
    public let maxPayloadSize: Int

    public init(
        channelName: String,
        twoWay: Bool = false,
        replyToolName: String = "reply",
        permissionRelay: Bool = false,
        instructions: String? = nil,
        httpBridge: Bool = false,
        httpBridgePort: Int = 3002,
        httpBridgeHost: String = "127.0.0.1",
        httpBridgeSecret: String? = nil,
        senderAllowlist: [String]? = nil,
        senderAllowlistFile: String? = nil,
        maxPayloadSize: Int = 64 * 1024
    ) {
        self.channelName = channelName
        self.twoWay = twoWay
        self.replyToolName = replyToolName
        self.permissionRelay = permissionRelay
        self.instructions = instructions
        self.httpBridge = httpBridge
        self.httpBridgePort = httpBridgePort
        self.httpBridgeHost = httpBridgeHost
        self.httpBridgeSecret = httpBridgeSecret
        self.senderAllowlist = senderAllowlist
        self.senderAllowlistFile = senderAllowlistFile
        self.maxPayloadSize = maxPayloadSize
    }
}

// MARK: - Channel Message

/// Internal representation of a channel message within smallchat.
public struct ChannelMessage: Sendable, Equatable {
    /// Message type discriminator.
    public let type: ChannelMessageType
    /// Source channel name.
    public let channel: String
    /// Message content.
    public let content: String
    /// Filtered metadata.
    public let meta: [String: String]?
    /// Sender identity (post-gating).
    public let sender: String?
    /// When the event was received (Unix milliseconds).
    public let receivedAt: UInt64
    /// Original raw event (for auditing).
    public let raw: ChannelEvent?

    public init(
        type: ChannelMessageType,
        channel: String,
        content: String,
        meta: [String: String]? = nil,
        sender: String? = nil,
        receivedAt: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000),
        raw: ChannelEvent? = nil
    ) {
        self.type = type
        self.channel = channel
        self.content = content
        self.meta = meta
        self.sender = sender
        self.receivedAt = receivedAt
        self.raw = raw
    }
}

/// Channel message type discriminator.
public enum ChannelMessageType: String, Sendable, Codable, Equatable {
    case channelEvent = "channel-event"
    case permissionRequest = "permission-request"
}

// MARK: - Channel Event (Observable)

/// Events emitted by the channel server for observation.
public enum ChannelServerEvent: Sendable {
    case ready
    case initialized
    case shutdown
    case eventInjected(ChannelEvent)
    case senderRejected(String?)
    case payloadTooLarge(size: Int, limit: Int)
    case permissionRequestReceived(PermissionRequest)
    case permissionVerdictSent(PermissionVerdict)
    case reply(channel: String, message: String, timestamp: String)
}

// MARK: - Notification Type

/// Types of MCP notifications used in the channel protocol.
public enum NotificationType: String, Sendable, Equatable {
    case channel = "notifications/claude/channel"
    case permissionRequest = "notifications/claude/channel/permission_request"
    case permission = "notifications/claude/channel/permission"
    case initialized = "notifications/initialized"
}
