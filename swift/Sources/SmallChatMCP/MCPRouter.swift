// MARK: - MCPRouter — JSON-RPC 2.0 dispatcher for MCP methods

import Foundation
import SmallChatCore

// MARK: - Router Options

/// Configuration options for the MCP router.
public struct RouterOptions: Sendable {
    public let serverName: String
    public let serverVersion: String
    public let sessionTTLMs: Int

    public init(
        serverName: String = "smallchat",
        serverVersion: String = "0.1.0",
        sessionTTLMs: Int = 86_400_000 // 24 hours
    ) {
        self.serverName = serverName
        self.serverVersion = serverVersion
        self.sessionTTLMs = sessionTTLMs
    }
}

// MARK: - MCPRouter Actor

/// Routes JSON-RPC 2.0 requests to appropriate MCP handlers.
///
/// Maps method strings to handler functions for initialize, tools/list,
/// tools/call, resources/list, resources/read, prompts/list, prompts/get, etc.
/// Returns nil for notifications (requests without an id).
public actor MCPRouter {

    private let sessionStore: SessionStore
    private let resourceRegistry: ResourceRegistry
    private let promptRegistry: PromptRegistry
    private let sseBroker: SSEBroker
    private let opts: RouterOptions
    private var artifact: SerializedArtifact?

    public init(
        sessionStore: SessionStore,
        resourceRegistry: ResourceRegistry,
        promptRegistry: PromptRegistry,
        sseBroker: SSEBroker,
        options: RouterOptions = RouterOptions()
    ) {
        self.sessionStore = sessionStore
        self.resourceRegistry = resourceRegistry
        self.promptRegistry = promptRegistry
        self.sseBroker = sseBroker
        self.opts = options
    }

    /// Set the artifact for tools/list.
    public func setArtifact(_ artifact: SerializedArtifact) {
        self.artifact = artifact
    }

    // MARK: - Main Dispatch

    /// Handle a parsed JSON-RPC request. Returns nil for notifications.
    public func handle(
        request: JSONRPCRequest,
        sessionId: String?
    ) async -> JSONRPCResponse? {
        // Notifications (no id) -- process and return nil
        guard let id = request.id else {
            return nil
        }

        let params = request.params ?? [:]

        do {
            switch request.method {
            case MCPMethod.initialize.rawValue:
                return await handleInitialize(id: id, params: params, sessionId: sessionId)
            case MCPMethod.ping.rawValue:
                return await handlePing(id: id, sessionId: sessionId)
            case MCPMethod.shutdown.rawValue:
                return await handleShutdown(id: id, sessionId: sessionId)
            case MCPMethod.notificationsInitialized.rawValue:
                return .ok(id, .dict([:]))
            case MCPMethod.toolsList.rawValue:
                return handleToolsList(id: id, params: params)
            case MCPMethod.toolsCall.rawValue:
                return handleToolsCall(id: id, params: params)
            case MCPMethod.resourcesList.rawValue:
                return await handleResourcesList(id: id, params: params, sessionId: sessionId)
            case MCPMethod.resourcesRead.rawValue:
                return await handleResourcesRead(id: id, params: params, sessionId: sessionId)
            case MCPMethod.resourcesTemplatesList.rawValue:
                return await handleResourcesTemplatesList(id: id, sessionId: sessionId)
            case MCPMethod.resourcesSubscribe.rawValue:
                return await handleResourcesSubscribe(id: id, params: params, sessionId: sessionId)
            case MCPMethod.promptsList.rawValue:
                return await handlePromptsList(id: id, params: params, sessionId: sessionId)
            case MCPMethod.promptsGet.rawValue:
                return await handlePromptsGet(id: id, params: params, sessionId: sessionId)
            default:
                return .error(id, code: MCPErrorCode.methodNotFound.rawValue,
                              message: "Method not found: \(request.method)")
            }
        } catch {
            return .error(id, code: MCPErrorCode.internalError.rawValue,
                          message: error.localizedDescription)
        }
    }

    // MARK: - Initialize

    private func handleInitialize(
        id: JSONRPCId,
        params: [String: AnyCodableValue],
        sessionId: String?
    ) async -> JSONRPCResponse {
        // Extract client info
        let clientName: String
        let clientVersion: String
        if case .dict(let clientInfo) = params["clientInfo"],
           case .string(let name) = clientInfo["name"],
           case .string(let version) = clientInfo["version"] {
            clientName = name
            clientVersion = version
        } else {
            clientName = "unknown"
            clientVersion = "unknown"
        }

        // Extract requested protocol version
        let requestedVersion: String
        if case .string(let v) = params["protocolVersion"] {
            requestedVersion = v
        } else {
            requestedVersion = mcpProtocolVersion
        }

        do {
            let session = try await sessionStore.create(
                protocolVersion: requestedVersion,
                clientInfo: ["name": clientName, "version": clientVersion]
            )

            let result: AnyCodableValue = .dict([
                "protocolVersion": .string(mcpProtocolVersion),
                "capabilities": .dict([
                    "tools": .dict(["listChanged": .bool(true)]),
                    "resources": .dict(["subscribe": .bool(true), "listChanged": .bool(true)]),
                    "prompts": .dict(["listChanged": .bool(true)]),
                    "logging": .dict([:]),
                ]),
                "serverInfo": .dict([
                    "name": .string(opts.serverName),
                    "version": .string(opts.serverVersion),
                ]),
                "sessionId": .string(session.id),
            ])

            return .ok(id, result)
        } catch {
            return .error(id, code: MCPErrorCode.internalError.rawValue,
                          message: "Failed to create session: \(error.localizedDescription)")
        }
    }

    // MARK: - Ping

    private func handlePing(id: JSONRPCId, sessionId: String?) async -> JSONRPCResponse {
        if let sessionId {
            try? await sessionStore.touch(sessionId)
        }
        return .ok(id, .dict(["ok": .bool(true)]))
    }

    // MARK: - Shutdown

    private func handleShutdown(id: JSONRPCId, sessionId: String?) async -> JSONRPCResponse {
        if let sessionId {
            try? await sessionStore.delete(sessionId)
            await sseBroker.disconnectSession(sessionId)
        }
        return .ok(id, .dict(["status": .string("shutdown")]))
    }

    // MARK: - Tools

    private func handleToolsList(id: JSONRPCId, params: [String: AnyCodableValue]) -> JSONRPCResponse {
        guard let artifact else {
            return .ok(id, .dict(["tools": .array([])]))
        }

        let allTools = buildToolList(artifact)
        let cursor: Int
        if case .string(let c) = params["cursor"], let parsed = Int(c) {
            cursor = parsed
        } else {
            cursor = 0
        }

        let pageSize = 100
        let page = Array(allTools.dropFirst(cursor).prefix(pageSize))
        let nextCursor = cursor + pageSize < allTools.count ? AnyCodableValue.string(String(cursor + pageSize)) : AnyCodableValue.null

        let toolValues: [AnyCodableValue] = page.map { .dict($0) }

        var resultDict: [String: AnyCodableValue] = ["tools": .array(toolValues)]
        if case .string = nextCursor {
            resultDict["nextCursor"] = nextCursor
        }

        return .ok(id, .dict(resultDict))
    }

    private func handleToolsCall(id: JSONRPCId, params: [String: AnyCodableValue]) -> JSONRPCResponse {
        guard case .string(let toolName) = params["name"] else {
            return .error(id, code: MCPErrorCode.invalidParams.rawValue, message: "Missing tool name")
        }

        // In the full implementation, this would dispatch to the runtime.
        // For now, return a placeholder indicating the tool was found.
        let invocationId = UUID().uuidString.lowercased()

        return .ok(id, .dict([
            "invocationId": .string(invocationId),
            "status": .string("ok"),
            "result": .dict(["note": .string("Tool execution for '\(toolName)' -- runtime dispatch pending")]),
        ]))
    }

    // MARK: - Resources

    private func handleResourcesList(
        id: JSONRPCId,
        params: [String: AnyCodableValue],
        sessionId: String?
    ) async -> JSONRPCResponse {
        let cursor: String?
        if case .string(let c) = params["cursor"] {
            cursor = c
        } else {
            cursor = nil
        }

        let result = await resourceRegistry.list(cursor: cursor)
        let resourceValues: [AnyCodableValue] = result.resources.map { resource in
            var dict: [String: AnyCodableValue] = [
                "uri": .string(resource.uri),
                "name": .string(resource.name),
                "providerId": .string(resource.providerId),
            ]
            if let desc = resource.description { dict["description"] = .string(desc) }
            if let mime = resource.mimeType { dict["mimeType"] = .string(mime) }
            return .dict(dict)
        }

        var resultDict: [String: AnyCodableValue] = ["resources": .array(resourceValues)]
        if let nc = result.nextCursor {
            resultDict["nextCursor"] = .string(nc)
        }

        return .ok(id, .dict(resultDict))
    }

    private func handleResourcesRead(
        id: JSONRPCId,
        params: [String: AnyCodableValue],
        sessionId: String?
    ) async -> JSONRPCResponse {
        guard case .string(let uri) = params["uri"] else {
            return .error(id, code: MCPErrorCode.invalidParams.rawValue, message: "Missing resource URI")
        }

        do {
            let content = try await resourceRegistry.read(uri: uri)
            var contentDict: [String: AnyCodableValue] = [
                "uri": .string(content.uri),
                "mimeType": .string(content.mimeType),
            ]
            if let text = content.text { contentDict["text"] = .string(text) }
            if let blob = content.blob { contentDict["blob"] = .string(blob) }

            return .ok(id, .dict(["contents": .array([.dict(contentDict)])]))
        } catch is ResourceNotFoundError {
            return .error(id, code: MCPErrorCode.resourceNotFound.rawValue,
                          message: "Resource not found: \(uri)")
        } catch {
            return .error(id, code: MCPErrorCode.internalError.rawValue,
                          message: error.localizedDescription)
        }
    }

    private func handleResourcesTemplatesList(
        id: JSONRPCId,
        sessionId: String?
    ) async -> JSONRPCResponse {
        let templates = await resourceRegistry.listTemplates()
        let templateValues: [AnyCodableValue] = templates.map { template in
            var dict: [String: AnyCodableValue] = [
                "uriTemplate": .string(template.uriTemplate),
                "name": .string(template.name),
            ]
            if let desc = template.description { dict["description"] = .string(desc) }
            if let mime = template.mimeType { dict["mimeType"] = .string(mime) }
            return .dict(dict)
        }

        return .ok(id, .dict(["resourceTemplates": .array(templateValues)]))
    }

    private func handleResourcesSubscribe(
        id: JSONRPCId,
        params: [String: AnyCodableValue],
        sessionId: String?
    ) async -> JSONRPCResponse {
        guard case .string(let uri) = params["uri"] else {
            return .error(id, code: MCPErrorCode.invalidParams.rawValue, message: "Missing resource URI")
        }

        let subId = await resourceRegistry.subscribe(uri: uri) { _ in
            // Subscription callback -- in practice, would notify via SSE
        }

        return .ok(id, .dict(["subscriptionId": .string(subId)]))
    }

    // MARK: - Prompts

    private func handlePromptsList(
        id: JSONRPCId,
        params: [String: AnyCodableValue],
        sessionId: String?
    ) async -> JSONRPCResponse {
        let result = await promptRegistry.list()
        let promptValues: [AnyCodableValue] = result.prompts.map { prompt in
            var dict: [String: AnyCodableValue] = [
                "name": .string(prompt.name),
            ]
            if let desc = prompt.description { dict["description"] = .string(desc) }
            if let args = prompt.arguments {
                dict["arguments"] = .array(args.map { arg in
                    var argDict: [String: AnyCodableValue] = ["name": .string(arg.name)]
                    if let desc = arg.description { argDict["description"] = .string(desc) }
                    if let req = arg.required { argDict["required"] = .bool(req) }
                    return .dict(argDict)
                })
            }
            return .dict(dict)
        }

        return .ok(id, .dict(["prompts": .array(promptValues)]))
    }

    private func handlePromptsGet(
        id: JSONRPCId,
        params: [String: AnyCodableValue],
        sessionId: String?
    ) async -> JSONRPCResponse {
        guard case .string(let name) = params["name"] else {
            return .error(id, code: MCPErrorCode.invalidParams.rawValue, message: "Missing prompt name")
        }

        // Extract string arguments
        var args: [String: String]?
        if case .dict(let argsDict) = params["arguments"] {
            args = [:]
            for (k, v) in argsDict {
                if case .string(let s) = v {
                    args?[k] = s
                }
            }
        }

        do {
            let result = try await promptRegistry.get(name: name, args: args)
            var resultDict: [String: AnyCodableValue] = [:]
            if let desc = result.description {
                resultDict["description"] = .string(desc)
            }

            let messageValues: [AnyCodableValue] = result.messages.map { msg in
                var msgDict: [String: AnyCodableValue] = [
                    "role": .string(msg.role.rawValue),
                ]
                switch msg.content {
                case .text(let text):
                    msgDict["content"] = .dict(["type": .string("text"), "text": .string(text)])
                case .image(let data, let mimeType):
                    msgDict["content"] = .dict(["type": .string("image"), "data": .string(data), "mimeType": .string(mimeType)])
                case .resource(let uri, let text, let mimeType):
                    var resDict: [String: AnyCodableValue] = ["uri": .string(uri)]
                    if let t = text { resDict["text"] = .string(t) }
                    if let m = mimeType { resDict["mimeType"] = .string(m) }
                    msgDict["content"] = .dict(["type": .string("resource"), "resource": .dict(resDict)])
                }
                return .dict(msgDict)
            }
            resultDict["messages"] = .array(messageValues)

            return .ok(id, .dict(resultDict))
        } catch is PromptNotFoundError {
            return .error(id, code: MCPErrorCode.promptNotFound.rawValue,
                          message: "Prompt not found: \(name)")
        } catch {
            return .error(id, code: MCPErrorCode.internalError.rawValue,
                          message: error.localizedDescription)
        }
    }
}
