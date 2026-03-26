// MARK: - Channel Server
// Stdio MCP server that acts as a Claude Code channel.
//
// Protocol:
//   stdin/stdout -- JSON-RPC 2.0 (newline-delimited) with MCP host (Claude Code)
//   HTTP bridge  -- optional (not implemented here; uses SmallChatTransport/NIO)
//
// This actor manages the channel server lifecycle, routes incoming messages
// through the adapter, and manages channel connections.

import Foundation
import SmallChatCore

// MARK: - JSON-RPC Types (stdio protocol)

/// A JSON-RPC 2.0 message for the stdio channel protocol.
public struct JsonRpcMessage: Sendable, Codable {
    public let jsonrpc: String
    public var id: AnyCodableValue?
    public var method: String?
    public var params: [String: AnyCodableValue]?
    public var result: AnyCodableValue?
    public var error: JsonRpcError?

    public init(
        jsonrpc: String = "2.0",
        id: AnyCodableValue? = nil,
        method: String? = nil,
        params: [String: AnyCodableValue]? = nil,
        result: AnyCodableValue? = nil,
        error: JsonRpcError? = nil
    ) {
        self.jsonrpc = jsonrpc
        self.id = id
        self.method = method
        self.params = params
        self.result = result
        self.error = error
    }
}

/// A JSON-RPC error object.
public struct JsonRpcError: Sendable, Codable, Equatable {
    public let code: Int
    public let message: String
    public let data: AnyCodableValue?

    public init(code: Int, message: String, data: AnyCodableValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

// MARK: - ChannelServer

/// Channel server that communicates over stdio using JSON-RPC 2.0.
///
/// Manages:
///   - MCP initialize handshake
///   - Channel event injection with sender gating
///   - Permission relay
///   - Reply tool (two-way channels)
///   - Event broadcasting via AsyncStream
public actor ChannelServer {
    private let config: ChannelServerConfig
    private let adapter: ClaudeCodeChannelAdapter
    private let senderGate: SenderGate
    private var initialized: Bool = false
    private var nextId: Int = 1
    private var pendingPermissions: [String: PermissionRequest] = [:]
    private var isRunning: Bool = false

    /// Stream for outbound JSON-RPC messages (to be written to stdout).
    private var outboundContinuation: AsyncStream<String>.Continuation?
    private var _outboundStream: AsyncStream<String>?

    /// Stream for server events (for observation/logging).
    private var eventContinuation: AsyncStream<ChannelServerEvent>.Continuation?
    private var _eventStream: AsyncStream<ChannelServerEvent>?

    public init(config: ChannelServerConfig) {
        self.config = config
        self.adapter = ClaudeCodeChannelAdapter(
            maxPayloadBytes: config.maxPayloadSize
        )
        self.senderGate = SenderGate(
            allowlist: config.senderAllowlist,
            allowlistFile: config.senderAllowlistFile
        )
    }

    // MARK: - Streams

    /// Stream of outbound JSON-RPC messages to write to stdout.
    public var outboundMessages: AsyncStream<String> {
        if let stream = _outboundStream { return stream }
        let (stream, continuation) = AsyncStream<String>.makeStream()
        _outboundStream = stream
        outboundContinuation = continuation
        return stream
    }

    /// Stream of server events for observation.
    public var events: AsyncStream<ChannelServerEvent> {
        if let stream = _eventStream { return stream }
        let (stream, continuation) = AsyncStream<ChannelServerEvent>.makeStream()
        _eventStream = stream
        eventContinuation = continuation
        return stream
    }

    // MARK: - Lifecycle

    /// Start the channel server.
    public func start() {
        // Ensure streams are initialized
        _ = outboundMessages
        _ = events
        isRunning = true
        emitEvent(.ready)
    }

    /// Shut down the server and clean up.
    public func shutdown() {
        isRunning = false
        outboundContinuation?.finish()
        outboundContinuation = nil
        _outboundStream = nil
        eventContinuation?.finish()
        eventContinuation = nil
        _eventStream = nil
        emitEvent(.shutdown)
    }

    // MARK: - Inbound Message Handling

    /// Handle an inbound line from stdin (JSON-RPC).
    public func handleLine(_ line: String) async {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        guard let data = trimmed.data(using: .utf8) else { return }
        let decoder = JSONDecoder()
        guard let msg = try? decoder.decode(JsonRpcMessage.self, from: data) else { return }
        guard msg.jsonrpc == "2.0" else { return }

        // Request (has id + method)
        if let id = msg.id, let method = msg.method {
            await handleRequest(id: id, method: method, params: msg.params ?? [:])
            return
        }

        // Notification (has method, no id)
        if let method = msg.method, msg.id == nil {
            await handleNotification(method: method, params: msg.params ?? [:])
            return
        }

        // Otherwise it's a response -- ignore
    }

    // MARK: - Event Injection

    /// Inject an inbound channel event.
    /// Validates sender gating and payload size, then emits the MCP notification.
    public func injectEvent(_ event: ChannelEvent) async -> Bool {
        // Sender gating
        let gateEnabled = await senderGate.isEnabled
        if gateEnabled {
            let allowed = await senderGate.check(event.sender)
            if !allowed {
                emitEvent(.senderRejected(event.sender))
                return false
            }
        }

        // Payload size check
        let sizeCheck = validatePayloadSize(event.content, maxBytes: config.maxPayloadSize)
        if !sizeCheck.valid {
            emitEvent(.payloadTooLarge(size: sizeCheck.size, limit: sizeCheck.limit))
            return false
        }

        // Filter meta keys
        let filteredMeta = filterMetaKeys(event.meta)

        let cleanEvent = ChannelEvent(
            channel: event.channel.isEmpty ? config.channelName : event.channel,
            content: event.content,
            meta: filteredMeta,
            sender: event.sender,
            timestamp: event.timestamp ?? ISO8601DateFormatter().string(from: Date())
        )

        // Ingest into adapter
        await adapter.ingest(cleanEvent)

        // Emit MCP notification over stdio
        sendNotification(
            method: NotificationType.channel.rawValue,
            params: [
                "channel": .string(cleanEvent.channel),
                "content": .string(cleanEvent.content),
            ].merging(
                metaToParams(cleanEvent.meta),
                uniquingKeysWith: { _, new in new }
            )
        )

        emitEvent(.eventInjected(cleanEvent))
        return true
    }

    /// Send a permission verdict back to the host.
    public func sendPermissionVerdict(_ verdict: PermissionVerdict) {
        sendNotification(
            method: NotificationType.permission.rawValue,
            params: [
                "request_id": .string(verdict.requestId),
                "behavior": .string(verdict.behavior.rawValue),
            ]
        )
        pendingPermissions.removeValue(forKey: verdict.requestId)
        emitEvent(.permissionVerdictSent(verdict))
    }

    // MARK: - Accessors

    /// Get the channel adapter.
    public func getAdapter() -> ClaudeCodeChannelAdapter {
        adapter
    }

    /// Get the sender gate.
    public func getSenderGate() -> SenderGate {
        senderGate
    }

    /// Get the server configuration.
    public func getConfig() -> ChannelServerConfig {
        config
    }

    /// Whether the server has been initialized by the MCP host.
    public func isInitialized() -> Bool {
        initialized
    }

    /// Get pending permission requests.
    public func getPendingPermissions() -> [String: PermissionRequest] {
        pendingPermissions
    }

    // MARK: - Request Handling

    private func handleRequest(id: AnyCodableValue, method: String, params: [String: AnyCodableValue]) async {
        switch method {
        case "initialize":
            handleInitialize(id: id, params: params)

        case "ping":
            sendResponse(id: id, result: .dict([:]))

        case "tools/list":
            handleToolsList(id: id)

        case "tools/call":
            handleToolsCall(id: id, params: params)

        default:
            sendError(id: id, code: -32601, message: "Unknown method: \(method)")
        }
    }

    private func handleNotification(method: String, params: [String: AnyCodableValue]) async {
        switch method {
        case NotificationType.initialized.rawValue:
            initialized = true
            emitEvent(.initialized)

        case NotificationType.permissionRequest.rawValue:
            await handlePermissionRequest(params: params)

        default:
            break
        }
    }

    private func handleInitialize(id: AnyCodableValue, params: [String: AnyCodableValue]) {
        var experimental: [String: AnyCodableValue] = [
            "claude/channel": .dict([:])
        ]
        if config.permissionRelay {
            experimental["claude/channel/permission"] = .dict([:])
        }

        var resultDict: [String: AnyCodableValue] = [
            "protocolVersion": .string("2024-11-05"),
            "capabilities": .dict([
                "tools": .dict([:]),
                "experimental": .dict(experimental),
            ]),
            "serverInfo": .dict([
                "name": .string("smallchat-channel-\(config.channelName)"),
                "version": .string("0.1.0"),
            ]),
        ]

        if let instructions = config.instructions {
            resultDict["instructions"] = .string(instructions)
        }

        sendResponse(id: id, result: .dict(resultDict))
    }

    private func handleToolsList(id: AnyCodableValue) {
        var tools: [AnyCodableValue] = []

        if config.twoWay {
            let replyName = config.replyToolName
            tools.append(.dict([
                "name": .string(replyName),
                "description": .string("Send a reply message to the \(config.channelName) channel"),
                "inputSchema": .dict([
                    "type": .string("object"),
                    "properties": .dict([
                        "message": .dict([
                            "type": .string("string"),
                            "description": .string("The message to send"),
                        ]),
                    ]),
                    "required": .array([.string("message")]),
                ]),
            ]))
        }

        sendResponse(id: id, result: .dict(["tools": .array(tools)]))
    }

    private func handleToolsCall(id: AnyCodableValue, params: [String: AnyCodableValue]) {
        guard case .string(let toolName) = params["name"] else {
            sendError(id: id, code: -32602, message: "Missing tool name")
            return
        }

        let args: [String: AnyCodableValue]
        if case .dict(let a) = params["arguments"] {
            args = a
        } else {
            args = [:]
        }

        let replyName = config.replyToolName

        if toolName == replyName && config.twoWay {
            guard case .string(let message) = args["message"], !message.isEmpty else {
                sendError(id: id, code: -32602, message: "Missing required argument: message")
                return
            }

            let timestamp = ISO8601DateFormatter().string(from: Date())
            emitEvent(.reply(channel: config.channelName, message: message, timestamp: timestamp))

            sendResponse(id: id, result: .dict([
                "content": .array([
                    .dict([
                        "type": .string("text"),
                        "text": .string("Reply sent to \(config.channelName)"),
                    ]),
                ]),
            ]))
            return
        }

        sendError(id: id, code: -32601, message: "Unknown tool: \(toolName)")
    }

    private func handlePermissionRequest(params: [String: AnyCodableValue]) async {
        guard config.permissionRelay else { return }

        guard let request = await adapter.parsePermissionRequest(params: params) else { return }

        pendingPermissions[request.requestId] = request
        emitEvent(.permissionRequestReceived(request))
    }

    // MARK: - JSON-RPC Output

    private func sendResponse(id: AnyCodableValue, result: AnyCodableValue) {
        let msg = JsonRpcMessage(id: id, result: result)
        writeMessage(msg)
    }

    private func sendError(id: AnyCodableValue, code: Int, message: String) {
        let msg = JsonRpcMessage(id: id, error: JsonRpcError(code: code, message: message))
        writeMessage(msg)
    }

    private func sendNotification(method: String, params: [String: AnyCodableValue]) {
        let msg = JsonRpcMessage(method: method, params: params)
        writeMessage(msg)
    }

    private func writeMessage(_ msg: JsonRpcMessage) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(msg),
              let json = String(data: data, encoding: .utf8) else { return }
        outboundContinuation?.yield(json)
    }

    // MARK: - Helpers

    private func emitEvent(_ event: ChannelServerEvent) {
        eventContinuation?.yield(event)
    }

    private func metaToParams(_ meta: [String: String]?) -> [String: AnyCodableValue] {
        guard let meta, !meta.isEmpty else { return [:] }
        var dict: [String: AnyCodableValue] = [:]
        for (key, value) in meta {
            dict[key] = .string(value)
        }
        return ["meta": .dict(dict)]
    }
}
