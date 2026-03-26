import Foundation

/// HTTP method for transport requests.
public enum HTTPMethod: String, Sendable, Codable, CaseIterable {
    case GET
    case POST
    case PUT
    case DELETE
    case PATCH
    case HEAD
    case OPTIONS
}

/// Input to a transport operation.
///
/// Mirrors the TypeScript `TransportInput` interface.
/// Contains all information needed to execute a tool call through any transport.
public struct TransportInput: Sendable {

    /// Tool name / operation ID.
    public var toolName: String

    /// Arguments to pass to the tool.
    public var args: [String: AnySendable]

    /// HTTP method override (for HTTP transports).
    public var method: HTTPMethod?

    /// URL or URL path override (for HTTP transports).
    public var url: String?

    /// Additional headers.
    public var headers: [String: String]

    /// Request body data (pre-serialized).
    public var body: Data?

    /// Request timeout in seconds (overrides transport-level timeout).
    public var timeout: TimeInterval?

    /// Whether to stream the response.
    public var stream: Bool

    /// Arbitrary metadata for transport-specific extensions.
    public var metadata: [String: String]

    public init(
        toolName: String = "",
        args: [String: AnySendable] = [:],
        method: HTTPMethod? = nil,
        url: String? = nil,
        headers: [String: String] = [:],
        body: Data? = nil,
        timeout: TimeInterval? = nil,
        stream: Bool = false,
        metadata: [String: String] = [:]
    ) {
        self.toolName = toolName
        self.args = args
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.timeout = timeout
        self.stream = stream
        self.metadata = metadata
    }
}

// MARK: - AnySendable

/// Type-erased Sendable wrapper for use in argument dictionaries.
public struct AnySendable: Sendable {
    public let value: any Sendable

    public init(_ value: any Sendable) {
        self.value = value
    }

    /// Attempt to unwrap the value as a specific type.
    public func `as`<T>(_ type: T.Type) -> T? {
        value as? T
    }
}

extension AnySendable: CustomStringConvertible {
    public var description: String {
        String(describing: value)
    }
}
