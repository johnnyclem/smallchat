// MARK: - MCPServer — NIO-based HTTP server for MCP protocol

import Foundation
import NIOCore
import NIOHTTP1
import SmallChatCore

// MARK: - Server Configuration

/// Configuration for the MCP HTTP server.
public struct MCPServerConfig: Sendable {
    /// Port to listen on.
    public let port: Int
    /// Host to bind to.
    public let host: String
    /// Source directory or compiled artifact path.
    public let sourcePath: String
    /// SQLite database path for sessions.
    public let dbPath: String
    /// Enable OAuth 2.1 authentication.
    public let enableAuth: Bool
    /// Enable rate limiting.
    public let enableRateLimit: Bool
    /// Max requests per minute per client.
    public let rateLimitRPM: Int
    /// Enable audit logging.
    public let enableAudit: Bool
    /// Session TTL in milliseconds.
    public let sessionTTLMs: Int

    public init(
        port: Int = 3000,
        host: String = "127.0.0.1",
        sourcePath: String,
        dbPath: String = "smallchat.db",
        enableAuth: Bool = false,
        enableRateLimit: Bool = false,
        rateLimitRPM: Int = 600,
        enableAudit: Bool = false,
        sessionTTLMs: Int = 86_400_000
    ) {
        self.port = port
        self.host = host
        self.sourcePath = sourcePath
        self.dbPath = dbPath
        self.enableAuth = enableAuth
        self.enableRateLimit = enableRateLimit
        self.rateLimitRPM = rateLimitRPM
        self.enableAudit = enableAudit
        self.sessionTTLMs = sessionTTLMs
    }
}

// MARK: - MCPServer Actor

/// MCP 2024-11-05 protocol server over HTTP.
///
/// Composes extracted modules for session management, OAuth, resources,
/// prompts, rate limiting, audit logging, and SSE streaming.
/// Uses SwiftNIO for the HTTP server layer.
public actor MCPServer {

    private let config: MCPServerConfig
    private let sessionStore: SessionStore
    private let oauthManager: OAuthManager
    private let resourceRegistry: ResourceRegistry
    private let promptRegistry: PromptRegistry
    private let rateLimiter: RateLimiter
    private let auditLog: AuditLog
    private let sseBroker: SSEBroker
    private let router: MCPRouter
    private var artifact: SerializedArtifact?
    private var eventLoopGroup: (any EventLoopGroup)?
    private var serverChannel: Channel?

    public init(config: MCPServerConfig) throws {
        self.config = config
        self.sessionStore = try SessionStore(dbPath: config.dbPath)
        self.oauthManager = OAuthManager()
        self.resourceRegistry = ResourceRegistry()
        self.promptRegistry = PromptRegistry()
        self.rateLimiter = RateLimiter(maxRPM: config.rateLimitRPM)
        self.auditLog = AuditLog()
        self.sseBroker = SSEBroker()
        self.router = MCPRouter(
            sessionStore: sessionStore,
            resourceRegistry: resourceRegistry,
            promptRegistry: promptRegistry,
            sseBroker: sseBroker,
            options: RouterOptions(
                serverName: mcpServerName,
                serverVersion: mcpServerVersion,
                sessionTTLMs: config.sessionTTLMs
            )
        )
    }

    // MARK: - Public Accessors

    /// Access the resource registry for registering handlers.
    public var resources: ResourceRegistry { resourceRegistry }

    /// Access the prompt registry for registering handlers.
    public var prompts: PromptRegistry { promptRegistry }

    /// Access the OAuth manager.
    public var oauth: OAuthManager { oauthManager }

    /// Access the SSE broker.
    public var sse: SSEBroker { sseBroker }

    /// Access the audit log.
    public var audit: AuditLog { auditLog }

    // MARK: - Lifecycle

    /// Start the MCP server.
    public func start() async throws {
        // Load artifact if path is provided
        if config.sourcePath.hasSuffix(".json") {
            let loadedArtifact = try ArtifactIO.load(from: config.sourcePath)
            self.artifact = loadedArtifact
            await router.setArtifact(loadedArtifact)
        }

        // Prune expired sessions
        try await sessionStore.prune(maxAgeMs: config.sessionTTLMs)

        let group = MultiThreadedEventLoopGroup(numberOfThreads: System.coreCount)
        self.eventLoopGroup = group

        let reuseAddrOpt = ChannelOptions.socket(SocketOptionLevel(SOL_SOCKET), SO_REUSEADDR)

        let bootstrap = ServerBootstrap(group: group)
            .serverChannelOption(ChannelOptions.backlog, value: 256)
            .serverChannelOption(reuseAddrOpt, value: 1)
            .childChannelInitializer { channel in
                channel.pipeline.configureHTTPServerPipeline().flatMap {
                    channel.pipeline.addHandler(MCPHTTPHandler(server: self))
                }
            }
            .childChannelOption(reuseAddrOpt, value: 1)
            .childChannelOption(ChannelOptions.maxMessagesPerRead, value: 16)

        let channel = try await bootstrap.bind(host: config.host, port: config.port).get()
        self.serverChannel = channel
    }

    /// Stop the MCP server.
    public func stop() async throws {
        await sseBroker.disconnectSession("*") // Disconnect all
        try await serverChannel?.close()
        try await eventLoopGroup?.shutdownGracefully()
        serverChannel = nil
        eventLoopGroup = nil
    }

    // MARK: - Request Processing

    /// Process a JSON-RPC request body and return a response.
    func processJSONRPC(
        body: String,
        sessionId: String?,
        clientAddress: String?,
        authHeader: String?,
        acceptsSSE: Bool
    ) async -> (response: JSONRPCResponse?, headers: [String: String]) {
        let startTime = ContinuousClock.now
        var extraHeaders: [String: String] = [:]

        // Parse request
        let request: JSONRPCRequest
        do {
            guard let data = body.data(using: .utf8) else {
                let resp = JSONRPCResponse.error(.null, code: MCPErrorCode.parseError.rawValue, message: "Parse error")
                return (resp, extraHeaders)
            }
            let dict = try JSONDecoder().decode([String: AnyCodableValue].self, from: data)
            switch validateRPCEnvelope(dict) {
            case .success(let req):
                request = req
            case .failure(let err):
                let resp = JSONRPCResponse(id: .null, error: err)
                return (resp, extraHeaders)
            }
        } catch {
            let resp = JSONRPCResponse.error(.null, code: MCPErrorCode.parseError.rawValue, message: "Parse error")
            return (resp, extraHeaders)
        }

        let id = request.id ?? .null

        // Auth guard
        if config.enableAuth {
            let auth = await oauthManager.extractBearerToken(authHeader)
            if !auth.active && request.method != MCPMethod.initialize.rawValue {
                let resp = JSONRPCResponse.error(id, code: MCPErrorCode.unsupportedVersion.rawValue, message: "Authentication required")
                return (resp, extraHeaders)
            }
        }

        // Rate limit guard
        if config.enableRateLimit {
            let clientKey = sessionId ?? clientAddress ?? "unknown"
            let allowed = await rateLimiter.check(clientId: clientKey)
            if !allowed {
                let resp = JSONRPCResponse.error(id, code: MCPErrorCode.unsupportedVersion.rawValue, message: "Rate limit exceeded")
                return (resp, extraHeaders)
            }
        }

        // Touch session
        if let sessionId {
            try? await sessionStore.touch(sessionId)
        }

        // Route request
        let response = await router.handle(request: request, sessionId: sessionId)

        // If the response contains a sessionId, propagate as header
        if let response,
           case .dict(let resultDict) = response.result,
           case .string(let newSessionId) = resultDict["sessionId"] {
            extraHeaders["Mcp-Session-Id"] = newSessionId
        }

        // Audit trail
        if config.enableAudit {
            let elapsed = ContinuousClock.now - startTime
            let durationMs = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
            await auditLog.log(AuditEntry(
                method: request.method,
                sessionId: sessionId,
                success: response?.error == nil,
                durationMs: durationMs,
                error: response?.error?.message
            ))
        }

        return (response, extraHeaders)
    }

    /// Build the MCP discovery document.
    func discoveryDocument() -> [String: AnyCodableValue] {
        [
            "mcpVersion": .string(mcpProtocolVersion),
            "serverInfo": .dict([
                "name": .string(mcpServerName),
                "version": .string(mcpServerVersion),
            ]),
            "capabilities": .dict([
                "tools": .dict(["listChanged": .bool(true)]),
                "resources": .dict(["subscribe": .bool(true), "listChanged": .bool(true)]),
                "prompts": .dict(["listChanged": .bool(true)]),
                "logging": .dict([:]),
            ]),
            "endpoints": .dict([
                "jsonrpc": .string("/"),
                "sse": .string("/sse"),
                "health": .string("/health"),
                "oauth": .string("/oauth/token"),
            ]),
        ]
    }

    /// Build the health check response.
    func healthResponse() async -> [String: AnyCodableValue] {
        let sessionCount = (try? await sessionStore.count()) ?? 0
        let sseCount = await sseBroker.totalConnectionCount()
        return [
            "status": .string("ok"),
            "version": .string(mcpServerVersion),
            "protocolVersion": .string(mcpProtocolVersion),
            "tools": .int(artifact?.stats.toolCount ?? 0),
            "providers": .int(artifact?.stats.providerCount ?? 0),
            "sessions": .int(sessionCount),
            "sseClients": .int(sseCount),
        ]
    }

    /// Broadcast a list-changed notification to all SSE clients.
    public func broadcastListChanged(type: String) async {
        // In full implementation, would iterate all sessions and notify via SSE
    }
}

// MARK: - NIO HTTP Handler

/// SwiftNIO channel handler for MCP HTTP requests.
private final class MCPHTTPHandler: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart

    private let server: MCPServer
    private var requestMethod: HTTPMethod = .GET
    private var requestURI: String = "/"
    private var requestHeaders: HTTPHeaders = HTTPHeaders()
    private var bodyBuffer: ByteBuffer = ByteBuffer()

    init(server: MCPServer) {
        self.server = server
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let part = unwrapInboundIn(data)

        switch part {
        case .head(let head):
            requestMethod = head.method
            requestURI = head.uri
            requestHeaders = head.headers
            bodyBuffer.clear()
        case .body(var body):
            bodyBuffer.writeBuffer(&body)
        case .end:
            handleRequest(context: context)
        }
    }

    private func handleRequest(context: ChannelHandlerContext) {
        let method = requestMethod
        let uri = requestURI
        let headers = requestHeaders
        let body = bodyBuffer.readString(length: bodyBuffer.readableBytes) ?? ""

        let ctx = context
        Task { [server] in
            await self.processRequest(
                context: ctx,
                method: method,
                uri: uri,
                headers: headers,
                body: body,
                server: server
            )
        }
    }

    private func processRequest(
        context: ChannelHandlerContext,
        method: HTTPMethod,
        uri: String,
        headers: HTTPHeaders,
        body: String,
        server: MCPServer
    ) async {
        // CORS headers
        var responseHeaders = HTTPHeaders()
        responseHeaders.add(name: "Access-Control-Allow-Origin", value: "*")
        responseHeaders.add(name: "Access-Control-Allow-Methods", value: "POST, GET, OPTIONS")
        responseHeaders.add(name: "Access-Control-Allow-Headers", value: "Content-Type, Accept, Authorization, Mcp-Session-Id")
        responseHeaders.add(name: "Access-Control-Expose-Headers", value: "Mcp-Session-Id")

        // OPTIONS
        if method == .OPTIONS {
            sendResponse(context: context, status: .noContent, headers: responseHeaders, body: nil)
            return
        }

        // GET routes
        if method == .GET {
            switch uri {
            case "/.well-known/mcp.json":
                let discovery = await server.discoveryDocument()
                sendJSON(context: context, status: .ok, headers: responseHeaders, value: discovery)
                return
            case "/health":
                let health = await server.healthResponse()
                sendJSON(context: context, status: .ok, headers: responseHeaders, value: health)
                return
            case "/sse":
                // SSE endpoint -- send initial connection event
                responseHeaders.add(name: "Content-Type", value: "text/event-stream")
                responseHeaders.add(name: "Cache-Control", value: "no-cache")
                responseHeaders.add(name: "Connection", value: "keep-alive")
                let sseData = "{\"connected\":true,\"timestamp\":\(Int(Date().timeIntervalSince1970 * 1000))}"
                let sseBody = "event: connected\ndata: \(sseData)\n\n"
                sendResponse(context: context, status: .ok, headers: responseHeaders, body: sseBody)
                return
            default:
                break
            }
        }

        // POST /oauth/token
        if method == .POST && uri == "/oauth/token" {
            await handleOAuthToken(context: context, headers: headers, body: body, responseHeaders: &responseHeaders, server: server)
            return
        }

        // POST / or /rpc -- JSON-RPC
        if method == .POST && (uri == "/" || uri == "/rpc") {
            let sessionId = headers.first(name: "Mcp-Session-Id")
            let clientAddress = context.remoteAddress?.description
            let authHeader = headers.first(name: "Authorization")
            let acceptsSSE = headers.first(name: "Accept")?.contains("text/event-stream") ?? false

            let result = await server.processJSONRPC(
                body: body,
                sessionId: sessionId,
                clientAddress: clientAddress,
                authHeader: authHeader,
                acceptsSSE: acceptsSSE
            )

            for (key, value) in result.headers {
                responseHeaders.add(name: key, value: value)
            }

            if let response = result.response {
                sendJSON(context: context, status: .ok, headers: responseHeaders, value: response)
            } else {
                // Notification -- no response body
                sendResponse(context: context, status: .noContent, headers: responseHeaders, body: nil)
            }
            return
        }

        // 404
        responseHeaders.add(name: "Content-Type", value: "application/json")
        sendResponse(context: context, status: .notFound, headers: responseHeaders, body: "{\"error\":\"Not found\"}")
    }

    private func handleOAuthToken(
        context: ChannelHandlerContext,
        headers: HTTPHeaders,
        body: String,
        responseHeaders: inout HTTPHeaders,
        server: MCPServer
    ) async {
        // Parse form or JSON body
        let params: [String: String]
        let contentType = headers.first(name: "Content-Type") ?? ""
        if contentType.contains("application/json") {
            guard let data = body.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode([String: String].self, from: data) else {
                sendJSON(context: context, status: .badRequest, headers: responseHeaders, value: ["error": AnyCodableValue.string("invalid_request")])
                return
            }
            params = decoded
        } else {
            // URL-encoded form
            var decoded: [String: String] = [:]
            for pair in body.split(separator: "&") {
                let parts = pair.split(separator: "=", maxSplits: 1)
                if parts.count == 2 {
                    let key = String(parts[0]).removingPercentEncoding ?? String(parts[0])
                    let value = String(parts[1]).removingPercentEncoding ?? String(parts[1])
                    decoded[key] = value
                }
            }
            params = decoded
        }

        let grantType = params["grant_type"] ?? ""

        if grantType == "client_credentials" {
            let clientId = params["client_id"] ?? ""
            let clientSecret = params["client_secret"] ?? ""
            let scopes = params["scope"]?.split(separator: " ").map(String.init)

            let token = await server.oauth.issueToken(
                clientId: clientId,
                clientSecret: clientSecret,
                requestedScopes: scopes
            )

            guard let token else {
                sendJSON(context: context, status: .unauthorized, headers: responseHeaders, value: ["error": AnyCodableValue.string("invalid_client")])
                return
            }

            let response: [String: AnyCodableValue] = [
                "access_token": .string(token.accessToken),
                "token_type": .string(token.tokenType),
                "expires_in": .int(token.expiresIn),
                "scope": .string(token.scope),
                "refresh_token": token.refreshToken.map { .string($0) } ?? .null,
            ]
            sendJSON(context: context, status: .ok, headers: responseHeaders, value: response)
            return
        }

        if grantType == "refresh_token" {
            let refreshToken = params["refresh_token"] ?? ""
            let token = await server.oauth.refreshAccessToken(refreshToken)

            guard let token else {
                sendJSON(context: context, status: .unauthorized, headers: responseHeaders, value: ["error": AnyCodableValue.string("invalid_grant")])
                return
            }

            let response: [String: AnyCodableValue] = [
                "access_token": .string(token.accessToken),
                "token_type": .string(token.tokenType),
                "expires_in": .int(token.expiresIn),
                "scope": .string(token.scope),
                "refresh_token": token.refreshToken.map { .string($0) } ?? .null,
            ]
            sendJSON(context: context, status: .ok, headers: responseHeaders, value: response)
            return
        }

        sendJSON(context: context, status: .badRequest, headers: responseHeaders, value: ["error": AnyCodableValue.string("unsupported_grant_type")])
    }

    // MARK: - Response Helpers

    private func sendJSON<T: Encodable>(
        context: ChannelHandlerContext,
        status: HTTPResponseStatus,
        headers: HTTPHeaders,
        value: T
    ) {
        var headers = headers
        headers.replaceOrAdd(name: "Content-Type", value: "application/json")

        do {
            let encoder = JSONEncoder()
            if status == .ok {
                encoder.outputFormatting = [.prettyPrinted]
            }
            let data = try encoder.encode(value)
            let bodyString = String(data: data, encoding: .utf8) ?? "{}"
            sendResponse(context: context, status: status, headers: headers, body: bodyString)
        } catch {
            sendResponse(context: context, status: .internalServerError, headers: headers, body: "{\"error\":\"Encoding error\"}")
        }
    }

    private func sendResponse(
        context: ChannelHandlerContext,
        status: HTTPResponseStatus,
        headers: HTTPHeaders,
        body: String?
    ) {
        var headers = headers
        let bodyData: ByteBuffer?
        if let body {
            var buffer = context.channel.allocator.buffer(capacity: body.utf8.count)
            buffer.writeString(body)
            headers.replaceOrAdd(name: "Content-Length", value: "\(body.utf8.count)")
            bodyData = buffer
        } else {
            headers.replaceOrAdd(name: "Content-Length", value: "0")
            bodyData = nil
        }

        let head = HTTPResponseHead(version: .http1_1, status: status, headers: headers)
        context.write(wrapOutboundOut(.head(head)), promise: nil)
        if let bodyData {
            context.write(wrapOutboundOut(.body(.byteBuffer(bodyData))), promise: nil)
        }
        context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
    }
}
