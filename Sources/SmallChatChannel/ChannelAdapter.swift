// MARK: - Channel Adapter
// Transforms channel notifications into smallchat message objects and
// serializes events to <channel> tags for Claude model prompts.

import Foundation
import SmallChatCore

// MARK: - ClaudeCodeChannelAdapter

/// Bridges MCP channel notifications and smallchat's internal message/dispatch model.
///
/// Provides:
///   1. Parsing MCP notification params into ChannelEvent objects
///   2. Converting ChannelEvents into ChannelMessage objects for internal use
///   3. Serializing events to `<channel>` XML tags for prompt injection
///   4. Accumulating channel context for LLM conversations
public actor ClaudeCodeChannelAdapter {
    private var messages: [ChannelMessage] = []
    private let maxMessages: Int
    private let maxPayloadBytes: Int

    public init(maxMessages: Int = 100, maxPayloadBytes: Int = defaultMaxPayloadBytes) {
        self.maxMessages = maxMessages
        self.maxPayloadBytes = maxPayloadBytes
    }

    // MARK: - Parsing

    /// Parse MCP notifications/claude/channel params into a ChannelEvent.
    /// Returns nil if the payload is invalid or exceeds size limits.
    public func parseNotification(params: [String: AnyCodableValue]) -> ChannelEvent? {
        guard case .string(let channel) = params["channel"], !channel.isEmpty else { return nil }
        guard case .string(let content) = params["content"] else { return nil }

        let sizeCheck = validatePayloadSize(content, maxBytes: maxPayloadBytes)
        guard sizeCheck.valid else { return nil }

        let meta = extractMetaDictionary(from: params["meta"])
        let filteredMeta = filterMetaKeys(meta)

        let sender: String?
        if case .string(let s) = params["sender"] {
            sender = s
        } else {
            sender = nil
        }

        let timestamp: String?
        if case .string(let t) = params["timestamp"] {
            timestamp = t
        } else {
            timestamp = nil
        }

        return ChannelEvent(
            channel: channel,
            content: content,
            meta: filteredMeta,
            sender: sender,
            timestamp: timestamp
        )
    }

    /// Parse MCP notifications/claude/channel/permission_request params.
    public func parsePermissionRequest(params: [String: AnyCodableValue]) -> PermissionRequest? {
        guard case .string(let requestId) = params["request_id"], !requestId.isEmpty else { return nil }
        guard case .string(let description) = params["description"] else { return nil }

        let toolName: String?
        if case .string(let tn) = params["tool_name"] {
            toolName = tn
        } else {
            toolName = nil
        }

        let toolArguments: [String: AnyCodableValue]?
        if case .dict(let ta) = params["tool_arguments"] {
            toolArguments = ta
        } else {
            toolArguments = nil
        }

        return PermissionRequest(
            requestId: requestId,
            description: description,
            toolName: toolName,
            toolArguments: toolArguments
        )
    }

    // MARK: - Ingestion

    /// Convert a ChannelEvent to a ChannelMessage and add to the context buffer.
    @discardableResult
    public func ingest(_ event: ChannelEvent) -> ChannelMessage {
        let message = ChannelMessage(
            type: .channelEvent,
            channel: event.channel,
            content: event.content,
            meta: event.meta,
            sender: event.sender,
            receivedAt: UInt64(Date().timeIntervalSince1970 * 1000),
            raw: event
        )

        messages.append(message)

        // Evict old messages if buffer is full
        if messages.count > maxMessages {
            messages = Array(messages.suffix(maxMessages))
        }

        return message
    }

    // MARK: - Retrieval

    /// Get all accumulated channel messages.
    public func getMessages() -> [ChannelMessage] {
        messages
    }

    /// Clear the message buffer.
    public func clear() {
        messages.removeAll()
    }

    // MARK: - Serialization

    /// Serialize all accumulated messages to `<channel>` XML tags for prompt generation.
    /// This is the format Claude Code uses to present channel events in LLM context.
    public func serializeForPrompt() -> String {
        messages.map { serializeChannelTag(channel: $0.channel, content: $0.content, meta: $0.meta) }
            .joined(separator: "\n\n")
    }

    /// Serialize a single event to a `<channel>` tag.
    public func serializeEvent(_ event: ChannelEvent) -> String {
        serializeChannelTag(channel: event.channel, content: event.content, meta: event.meta)
    }

    /// Build the notification params for emitting a channel event over MCP.
    public func buildNotificationParams(for event: ChannelEvent) -> ChannelNotificationParams {
        ChannelNotificationParams(
            channel: event.channel,
            content: event.content,
            meta: event.meta
        )
    }

    /// Build a permission verdict for sending back to the host.
    public func buildPermissionVerdict(requestId: String, behavior: PermissionBehavior) -> PermissionVerdict {
        PermissionVerdict(requestId: requestId, behavior: behavior)
    }

    // MARK: - Private

    /// Extract a [String: String] dictionary from an AnyCodableValue.dict.
    private func extractMetaDictionary(from value: AnyCodableValue?) -> [String: String]? {
        guard case .dict(let dict) = value else { return nil }
        var result: [String: String] = [:]
        for (key, val) in dict {
            switch val {
            case .string(let s):
                result[key] = s
            case .int(let i):
                result[key] = String(i)
            case .double(let d):
                result[key] = String(d)
            case .bool(let b):
                result[key] = String(b)
            case .null:
                continue
            case .array, .dict:
                result[key] = String(describing: val)
            }
        }
        return result.isEmpty ? nil : result
    }
}
