// MARK: - ResourceRegistry — MCP resource management

import Foundation

// MARK: - Resource Types

/// An MCP resource exposed to clients.
public struct MCPResource: Sendable, Codable {
    public let uri: String
    public let name: String
    public let description: String?
    public let mimeType: String?
    public let providerId: String

    public init(
        uri: String,
        name: String,
        description: String? = nil,
        mimeType: String? = nil,
        providerId: String
    ) {
        self.uri = uri
        self.name = name
        self.description = description
        self.mimeType = mimeType
        self.providerId = providerId
    }
}

/// Content of a resource read operation.
public struct MCPResourceContent: Sendable, Codable {
    public let uri: String
    public let mimeType: String
    public let text: String?
    public let blob: String?

    public init(
        uri: String,
        mimeType: String,
        text: String? = nil,
        blob: String? = nil
    ) {
        self.uri = uri
        self.mimeType = mimeType
        self.text = text
        self.blob = blob
    }
}

/// A URI template for resource discovery.
public struct MCPResourceTemplate: Sendable, Codable {
    public let uriTemplate: String
    public let name: String
    public let description: String?
    public let mimeType: String?

    public init(
        uriTemplate: String,
        name: String,
        description: String? = nil,
        mimeType: String? = nil
    ) {
        self.uriTemplate = uriTemplate
        self.name = name
        self.description = description
        self.mimeType = mimeType
    }
}

/// A resource change event for subscriptions.
public struct ResourceChangeEvent: Sendable {
    public enum ChangeType: String, Sendable {
        case created
        case updated
        case deleted
    }

    public let type: ChangeType
    public let uri: String
    public let timestamp: String

    public init(type: ChangeType, uri: String, timestamp: String? = nil) {
        self.type = type
        self.uri = uri
        self.timestamp = timestamp ?? ISO8601DateFormatter().string(from: Date())
    }
}

// MARK: - Resource Handler Protocol

/// A handler that provides resources for a specific provider.
public protocol ResourceHandler: Sendable {
    var providerId: String { get }
    func list(cursor: String?) async throws -> (resources: [MCPResource], nextCursor: String?)
    func read(uri: String) async throws -> MCPResourceContent
    func listTemplates() async throws -> [MCPResourceTemplate]
}

/// Default implementation for templates.
extension ResourceHandler {
    public func listTemplates() async throws -> [MCPResourceTemplate] { [] }
}

// MARK: - Errors

/// Error thrown when a resource is not found.
public struct ResourceNotFoundError: Error, Sendable {
    public let uri: String
    public var localizedDescription: String { "Resource not found: \(uri)" }

    public init(uri: String) {
        self.uri = uri
    }
}

// MARK: - Subscription

private struct Subscription: Sendable {
    let id: String
    let uri: String
    let callback: @Sendable (ResourceChangeEvent) -> Void
}

// MARK: - ResourceRegistry Actor

/// Registry for MCP resources with subscription support.
///
/// Handlers can be registered per provider, and clients can subscribe
/// to change notifications for specific URIs.
public actor ResourceRegistry {

    private var handlers: [String: any ResourceHandler] = [:]
    private var subscriptions: [String: [Subscription]] = [:] // uri -> subscriptions
    private var subscriptionCounter: Int = 0

    public init() {}

    // MARK: - Handler Management

    /// Register a resource handler for a provider.
    public func registerHandler(_ handler: any ResourceHandler) {
        handlers[handler.providerId] = handler
    }

    /// Remove a resource handler.
    public func unregisterHandler(providerId: String) {
        handlers.removeValue(forKey: providerId)
        // Clean up subscriptions for this provider
        let prefix = "\(providerId):"
        for uri in subscriptions.keys where uri.hasPrefix(prefix) {
            subscriptions.removeValue(forKey: uri)
        }
    }

    // MARK: - MCP resources/list

    /// List all resources from all handlers.
    public func list(cursor: String? = nil) async -> (resources: [MCPResource], nextCursor: String?) {
        var allResources: [MCPResource] = []
        var nextCursor: String?

        for handler in handlers.values {
            do {
                let result = try await handler.list(cursor: cursor)
                allResources.append(contentsOf: result.resources)
                if let nc = result.nextCursor {
                    nextCursor = nc
                }
            } catch {
                // Skip handlers that fail -- partial results are better than none
            }
        }

        return (resources: allResources, nextCursor: nextCursor)
    }

    // MARK: - MCP resources/read

    /// Read a specific resource by URI.
    public func read(uri: String) async throws -> MCPResourceContent {
        for handler in handlers.values {
            do {
                let content = try await handler.read(uri: uri)
                return content
            } catch {
                // Try next handler
            }
        }
        throw ResourceNotFoundError(uri: uri)
    }

    // MARK: - MCP resources/templates/list

    /// List all resource templates from all handlers.
    public func listTemplates() async -> [MCPResourceTemplate] {
        var templates: [MCPResourceTemplate] = []
        for handler in handlers.values {
            do {
                let result = try await handler.listTemplates()
                templates.append(contentsOf: result)
            } catch {
                // Skip handlers that fail
            }
        }
        return templates
    }

    // MARK: - Subscriptions

    /// Subscribe to changes for a URI. Returns a subscription ID.
    public func subscribe(uri: String, callback: @Sendable @escaping (ResourceChangeEvent) -> Void) -> String {
        subscriptionCounter += 1
        let id = "sub_\(subscriptionCounter)"
        let subscription = Subscription(id: id, uri: uri, callback: callback)

        var subs = subscriptions[uri] ?? []
        subs.append(subscription)
        subscriptions[uri] = subs

        return id
    }

    /// Unsubscribe by subscription ID. Returns true if found and removed.
    @discardableResult
    public func unsubscribe(_ subscriptionId: String) -> Bool {
        for (uri, var subs) in subscriptions {
            if let idx = subs.firstIndex(where: { $0.id == subscriptionId }) {
                subs.remove(at: idx)
                if subs.isEmpty {
                    subscriptions.removeValue(forKey: uri)
                } else {
                    subscriptions[uri] = subs
                }
                return true
            }
        }
        return false
    }

    /// Emit a change event to all subscribers of a URI.
    public func notifyChange(_ event: ResourceChangeEvent) {
        guard let subs = subscriptions[event.uri] else { return }
        for sub in subs {
            sub.callback(event)
        }
    }

    /// Check if any subscriptions exist for a URI.
    public func hasSubscribers(uri: String) -> Bool {
        guard let subs = subscriptions[uri] else { return false }
        return !subs.isEmpty
    }

    /// Get count of active subscriptions.
    public func subscriptionCount() -> Int {
        subscriptions.values.reduce(0) { $0 + $1.count }
    }
}
