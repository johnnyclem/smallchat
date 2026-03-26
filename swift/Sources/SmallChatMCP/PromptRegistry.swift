// MARK: - PromptRegistry — MCP prompt management

import Foundation
import SmallChatCore

// MARK: - Prompt Types

/// An MCP prompt definition.
public struct MCPPrompt: Sendable, Codable {
    public let name: String
    public let description: String?
    public let arguments: [MCPPromptArgument]?

    public init(
        name: String,
        description: String? = nil,
        arguments: [MCPPromptArgument]? = nil
    ) {
        self.name = name
        self.description = description
        self.arguments = arguments
    }
}

/// An argument definition for a prompt.
public struct MCPPromptArgument: Sendable, Codable {
    public let name: String
    public let description: String?
    public let required: Bool?

    public init(name: String, description: String? = nil, required: Bool? = nil) {
        self.name = name
        self.description = description
        self.required = required
    }
}

/// A message within a prompt rendering.
public struct MCPPromptMessage: Sendable, Codable {
    public let role: Role
    public let content: MCPPromptContent

    public init(role: Role, content: MCPPromptContent) {
        self.role = role
        self.content = content
    }

    public enum Role: String, Sendable, Codable {
        case user
        case assistant
        case system
    }
}

/// Content of a prompt message.
public enum MCPPromptContent: Sendable, Codable {
    case text(String)
    case image(data: String, mimeType: String)
    case resource(uri: String, text: String?, mimeType: String?)

    private enum ContentType: String, Codable {
        case text
        case image
        case resource
    }

    private enum CodingKeys: String, CodingKey {
        case type, text, data, mimeType, resource
    }

    private enum ResourceKeys: String, CodingKey {
        case uri, text, mimeType
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(ContentType.self, forKey: .type)
        switch type {
        case .text:
            let text = try container.decode(String.self, forKey: .text)
            self = .text(text)
        case .image:
            let data = try container.decode(String.self, forKey: .data)
            let mimeType = try container.decode(String.self, forKey: .mimeType)
            self = .image(data: data, mimeType: mimeType)
        case .resource:
            let resourceContainer = try container.nestedContainer(keyedBy: ResourceKeys.self, forKey: .resource)
            let uri = try resourceContainer.decode(String.self, forKey: .uri)
            let text = try resourceContainer.decodeIfPresent(String.self, forKey: .text)
            let mimeType = try resourceContainer.decodeIfPresent(String.self, forKey: .mimeType)
            self = .resource(uri: uri, text: text, mimeType: mimeType)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try container.encode(ContentType.text, forKey: .type)
            try container.encode(text, forKey: .text)
        case .image(let data, let mimeType):
            try container.encode(ContentType.image, forKey: .type)
            try container.encode(data, forKey: .data)
            try container.encode(mimeType, forKey: .mimeType)
        case .resource(let uri, let text, let mimeType):
            try container.encode(ContentType.resource, forKey: .type)
            var resourceContainer = container.nestedContainer(keyedBy: ResourceKeys.self, forKey: .resource)
            try resourceContainer.encode(uri, forKey: .uri)
            try resourceContainer.encodeIfPresent(text, forKey: .text)
            try resourceContainer.encodeIfPresent(mimeType, forKey: .mimeType)
        }
    }
}

// MARK: - Prompt Handler Protocol

/// A handler that provides prompts for a specific provider.
public protocol PromptHandler: Sendable {
    var providerId: String { get }
    func list() async throws -> [MCPPrompt]
    func get(name: String, args: [String: String]?) async throws -> [MCPPromptMessage]
}

// MARK: - Static Prompt

/// A statically defined prompt with template variable substitution.
public struct StaticPrompt: Sendable {
    public let name: String
    public let description: String?
    public let arguments: [MCPPromptArgument]?
    public let template: [MCPPromptMessage]

    public init(
        name: String,
        description: String? = nil,
        arguments: [MCPPromptArgument]? = nil,
        template: [MCPPromptMessage]
    ) {
        self.name = name
        self.description = description
        self.arguments = arguments
        self.template = template
    }
}

// MARK: - Errors

/// Error thrown when a prompt is not found.
public struct PromptNotFoundError: Error, Sendable {
    public let promptName: String
    public var localizedDescription: String { "Prompt not found: \(promptName)" }

    public init(name: String) {
        self.promptName = name
    }
}

// MARK: - PromptRegistry Actor

/// Registry for MCP prompts with handler and static prompt support.
///
/// Prompts can be provided by handlers (dynamic, from providers) or
/// registered statically as templates with {{variable}} substitution.
public actor PromptRegistry {

    private var handlers: [String: any PromptHandler] = [:]
    private var staticPrompts: [String: StaticPrompt] = [:]

    public init() {}

    // MARK: - Handler Management

    /// Register a prompt handler for a provider.
    public func registerHandler(_ handler: any PromptHandler) {
        handlers[handler.providerId] = handler
    }

    /// Remove a prompt handler.
    public func unregisterHandler(providerId: String) {
        handlers.removeValue(forKey: providerId)
    }

    /// Register a static prompt.
    public func registerPrompt(_ prompt: StaticPrompt) {
        staticPrompts[prompt.name] = prompt
    }

    // MARK: - MCP prompts/list

    /// List all available prompts.
    public func list(cursor: String? = nil) async -> (prompts: [MCPPrompt], nextCursor: String?) {
        var allPrompts: [MCPPrompt] = []

        // Collect from handlers
        for handler in handlers.values {
            do {
                let prompts = try await handler.list()
                allPrompts.append(contentsOf: prompts)
            } catch {
                // Skip failing handlers
            }
        }

        // Add static prompts
        for sp in staticPrompts.values {
            allPrompts.append(MCPPrompt(
                name: sp.name,
                description: sp.description,
                arguments: sp.arguments
            ))
        }

        return (prompts: allPrompts, nextCursor: nil)
    }

    // MARK: - MCP prompts/get

    /// Get and render a prompt with arguments.
    public func get(
        name: String,
        args: [String: String]? = nil
    ) async throws -> (description: String?, messages: [MCPPromptMessage]) {
        // Check static prompts first
        if let staticPrompt = staticPrompts[name] {
            let messages = renderStaticPrompt(staticPrompt, args: args)
            return (description: staticPrompt.description, messages: messages)
        }

        // Try each handler
        for handler in handlers.values {
            do {
                let prompts = try await handler.list()
                if prompts.contains(where: { $0.name == name }) {
                    let messages = try await handler.get(name: name, args: args)
                    return (description: nil, messages: messages)
                }
            } catch {
                // Try next handler
            }
        }

        throw PromptNotFoundError(name: name)
    }

    // MARK: - Template Rendering

    /// Render a static prompt by substituting {{variable}} placeholders.
    private func renderStaticPrompt(
        _ prompt: StaticPrompt,
        args: [String: String]?
    ) -> [MCPPromptMessage] {
        prompt.template.map { msg in
            MCPPromptMessage(
                role: msg.role,
                content: substituteContent(msg.content, args: args ?? [:])
            )
        }
    }

    /// Substitute {{variable}} placeholders in content.
    private func substituteContent(
        _ content: MCPPromptContent,
        args: [String: String]
    ) -> MCPPromptContent {
        switch content {
        case .text(var text):
            for (key, value) in args {
                text = text.replacingOccurrences(of: "{{\(key)}}", with: value)
            }
            return .text(text)
        case .image, .resource:
            return content
        }
    }
}
