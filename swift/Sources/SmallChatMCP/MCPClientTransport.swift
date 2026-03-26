// MARK: - MCPClientTransport — MCP client-side transport

import Foundation
import SmallChatCore

// MARK: - Transport Options

/// Configuration for an MCP client transport.
public struct MCPTransportOptions: Sendable {
    public let transportType: TransportType
    public let endpoint: String?
    public let headers: [String: String]

    public init(
        transportType: TransportType,
        endpoint: String? = nil,
        headers: [String: String] = [:]
    ) {
        self.transportType = transportType
        self.endpoint = endpoint
        self.headers = headers
    }
}

// MARK: - MCPClientTransport

/// Client-side transport for connecting to MCP servers.
///
/// Supports multiple transport types:
/// - MCP: JSON-RPC 2.0 over HTTP with optional SSE streaming
/// - REST: Standard HTTP API calls
/// - Local: In-process tool execution
/// - gRPC: Stub for future implementation
public actor MCPClientTransport {

    private let endpoint: String?
    private let transportType: TransportType
    private let headers: [String: String]
    private var requestCounter: Int = 0
    private var sessionId: String?

    public init(options: MCPTransportOptions) {
        self.endpoint = options.endpoint
        self.transportType = options.transportType
        self.headers = options.headers
    }

    // MARK: - Session Management

    /// The current session ID (set after initialize).
    public var currentSessionId: String? { sessionId }

    /// Set the session ID (typically from an initialize response).
    public func setSessionId(_ id: String) {
        sessionId = id
    }

    // MARK: - JSON-RPC Requests

    /// Send a JSON-RPC request and return the response.
    public func sendRequest(
        method: String,
        params: [String: AnyCodableValue]? = nil
    ) async throws -> JSONRPCResponse {
        requestCounter += 1
        let id = JSONRPCId.int(requestCounter)

        let request = JSONRPCRequest(id: id, method: method, params: params)
        return try await executeJSONRPC(request)
    }

    /// Send a notification (no response expected).
    public func sendNotification(
        method: String,
        params: [String: AnyCodableValue]? = nil
    ) async throws {
        let notification = JSONRPCNotification(method: method, params: params)
        try await sendJSONRPCNotification(notification)
    }

    // MARK: - MCP Protocol Operations

    /// Initialize the connection to an MCP server.
    public func initialize(
        clientName: String = "smallchat",
        clientVersion: String = "0.1.0"
    ) async throws -> JSONRPCResponse {
        let response = try await sendRequest(method: MCPMethod.initialize.rawValue, params: [
            "protocolVersion": .string(mcpProtocolVersion),
            "capabilities": .dict([:]),
            "clientInfo": .dict([
                "name": .string(clientName),
                "version": .string(clientVersion),
            ]),
        ])

        // Extract session ID from response
        if case .dict(let result) = response.result,
           case .string(let sid) = result["sessionId"] {
            sessionId = sid
        }

        // Send initialized notification
        try await sendNotification(method: MCPMethod.notificationsInitialized.rawValue)

        return response
    }

    /// List available tools from the server.
    public func listTools(cursor: String? = nil) async throws -> JSONRPCResponse {
        var params: [String: AnyCodableValue] = [:]
        if let cursor {
            params["cursor"] = .string(cursor)
        }
        return try await sendRequest(method: MCPMethod.toolsList.rawValue, params: params)
    }

    /// Call a tool on the server.
    public func callTool(
        name: String,
        arguments: [String: AnyCodableValue] = [:]
    ) async throws -> JSONRPCResponse {
        try await sendRequest(method: MCPMethod.toolsCall.rawValue, params: [
            "name": .string(name),
            "arguments": .dict(arguments),
        ])
    }

    /// List available resources.
    public func listResources(cursor: String? = nil) async throws -> JSONRPCResponse {
        var params: [String: AnyCodableValue] = [:]
        if let cursor {
            params["cursor"] = .string(cursor)
        }
        return try await sendRequest(method: MCPMethod.resourcesList.rawValue, params: params)
    }

    /// Read a resource by URI.
    public func readResource(uri: String) async throws -> JSONRPCResponse {
        try await sendRequest(method: MCPMethod.resourcesRead.rawValue, params: [
            "uri": .string(uri),
        ])
    }

    /// List available prompts.
    public func listPrompts(cursor: String? = nil) async throws -> JSONRPCResponse {
        var params: [String: AnyCodableValue] = [:]
        if let cursor {
            params["cursor"] = .string(cursor)
        }
        return try await sendRequest(method: MCPMethod.promptsList.rawValue, params: params)
    }

    /// Get a prompt by name with optional arguments.
    public func getPrompt(
        name: String,
        arguments: [String: String]? = nil
    ) async throws -> JSONRPCResponse {
        var params: [String: AnyCodableValue] = ["name": .string(name)]
        if let arguments {
            var argsDict: [String: AnyCodableValue] = [:]
            for (k, v) in arguments { argsDict[k] = .string(v) }
            params["arguments"] = .dict(argsDict)
        }
        return try await sendRequest(method: MCPMethod.promptsGet.rawValue, params: params)
    }

    /// Ping the server.
    public func ping() async throws -> JSONRPCResponse {
        try await sendRequest(method: MCPMethod.ping.rawValue)
    }

    /// Shutdown the session.
    public func shutdown() async throws -> JSONRPCResponse {
        try await sendRequest(method: MCPMethod.shutdown.rawValue)
    }

    // MARK: - Tool Execution

    /// Execute a tool call via the appropriate transport.
    public func execute(
        toolName: String,
        args: [String: AnyCodableValue]
    ) async throws -> ToolResult {
        switch transportType {
        case .mcp:
            return try await executeMCP(toolName: toolName, args: args)
        case .rest:
            return try await executeREST(toolName: toolName, args: args)
        case .local:
            return ToolResult(
                content: nil as (any Sendable)?,
                isError: true,
                metadata: ["error": "Local transport requires registered handler" as any Sendable]
            )
        case .grpc:
            return ToolResult(
                content: nil as (any Sendable)?,
                isError: true,
                metadata: ["error": "gRPC transport not yet implemented" as any Sendable]
            )
        }
    }

    /// Stream tool execution results.
    public func executeStream(
        toolName: String,
        args: [String: AnyCodableValue]
    ) -> AsyncThrowingStream<ToolResult, Error> {
        AsyncThrowingStream { continuation in
            Task { [weak self] in
                guard let self else {
                    continuation.finish()
                    return
                }
                do {
                    let result = try await self.execute(toolName: toolName, args: args)
                    continuation.yield(result)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Private Transport Methods

    private func executeMCP(toolName: String, args: [String: AnyCodableValue]) async throws -> ToolResult {
        let response = try await callTool(name: toolName, arguments: args)

        if let error = response.error {
            return ToolResult(
                content: nil as (any Sendable)?,
                isError: true,
                metadata: [
                    "error": error.message as any Sendable,
                    "code": error.code as any Sendable,
                ]
            )
        }

        if case .dict(let result) = response.result {
            let isError: Bool
            if case .bool(let e) = result["isError"] { isError = e } else { isError = false }

            return ToolResult(
                content: result["content"] as (any Sendable)?,
                isError: isError
            )
        }

        return ToolResult(content: nil as (any Sendable)?, isError: false)
    }

    private func executeREST(toolName: String, args: [String: AnyCodableValue]) async throws -> ToolResult {
        guard let endpoint else {
            return ToolResult(
                content: nil as (any Sendable)?,
                isError: true,
                metadata: ["error": "No REST endpoint configured" as any Sendable]
            )
        }

        let urlString = endpoint.hasSuffix("/") ? "\(endpoint)\(toolName)" : "\(endpoint)/\(toolName)"
        guard let url = URL(string: urlString) else {
            return ToolResult(
                content: nil as (any Sendable)?,
                isError: true,
                metadata: ["error": "Invalid URL: \(urlString)" as any Sendable]
            )
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }

        let bodyData = try JSONEncoder().encode(args)
        request.httpBody = bodyData

        let (data, response) = try await URLSession.shared.data(for: request)
        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        if let decoded = try? JSONDecoder().decode(AnyCodableValue.self, from: data) {
            return ToolResult(
                content: decoded as (any Sendable)?,
                isError: statusCode >= 400,
                metadata: ["statusCode": statusCode as any Sendable]
            )
        }

        let text = String(data: data, encoding: .utf8) ?? ""
        return ToolResult(
            content: text as (any Sendable)?,
            isError: statusCode >= 400,
            metadata: ["statusCode": statusCode as any Sendable]
        )
    }

    // MARK: - JSON-RPC Transport

    private func executeJSONRPC(_ request: JSONRPCRequest) async throws -> JSONRPCResponse {
        guard let endpoint else {
            return JSONRPCResponse.error(
                request.id ?? .null,
                code: MCPErrorCode.internalError.rawValue,
                message: "No endpoint configured"
            )
        }

        guard let url = URL(string: endpoint) else {
            return JSONRPCResponse.error(
                request.id ?? .null,
                code: MCPErrorCode.internalError.rawValue,
                message: "Invalid endpoint URL"
            )
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }
        if let sid = sessionId {
            urlRequest.setValue(sid, forHTTPHeaderField: "Mcp-Session-Id")
        }

        let bodyData = try JSONEncoder().encode(request)
        urlRequest.httpBody = bodyData

        let (data, _) = try await URLSession.shared.data(for: urlRequest)
        return try JSONDecoder().decode(JSONRPCResponse.self, from: data)
    }

    private func sendJSONRPCNotification(_ notification: JSONRPCNotification) async throws {
        guard let endpoint, let url = URL(string: endpoint) else { return }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }
        if let sid = sessionId {
            urlRequest.setValue(sid, forHTTPHeaderField: "Mcp-Session-Id")
        }

        let bodyData = try JSONEncoder().encode(notification)
        urlRequest.httpBody = bodyData

        // Fire and forget for notifications
        _ = try await URLSession.shared.data(for: urlRequest)
    }
}

// MARK: - Transport Registry

/// Registry for MCP client transport instances.
public actor MCPTransportRegistry {

    private var transports: [String: MCPClientTransport] = [:]

    public init() {}

    /// Get or create a transport for a provider.
    public func getTransport(providerId: String, options: MCPTransportOptions) -> MCPClientTransport {
        let key = "\(providerId):\(options.transportType.rawValue):\(options.endpoint ?? "local")"
        if let existing = transports[key] {
            return existing
        }
        let transport = MCPClientTransport(options: options)
        transports[key] = transport
        return transport
    }

    /// Clear all cached transports.
    public func clearAll() {
        transports.removeAll()
    }
}
