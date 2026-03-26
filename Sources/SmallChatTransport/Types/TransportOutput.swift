import Foundation

/// Output from a transport operation.
///
/// Mirrors the TypeScript `TransportOutput` and `TransportMetadata` interfaces.
public struct TransportOutput: Sendable {

    /// HTTP status code (0 for non-HTTP transports).
    public var statusCode: Int

    /// Response headers.
    public var headers: [String: String]

    /// Response body as raw data.
    public var body: Data?

    /// Arbitrary metadata about the response (timing, circuit state, etc.).
    public var metadata: [String: String]

    public init(
        statusCode: Int = 200,
        headers: [String: String] = [:],
        body: Data? = nil,
        metadata: [String: String] = [:]
    ) {
        self.statusCode = statusCode
        self.headers = headers
        self.body = body
        self.metadata = metadata
    }

    // MARK: - Convenience

    /// Whether this response represents an error (status >= 400 or metadata flag).
    public var isError: Bool {
        statusCode >= 400 || metadata["isError"] == "true"
    }

    /// Decode the body as JSON into the given `Decodable` type.
    public func decoded<T: Decodable>(as type: T.Type, using decoder: JSONDecoder = JSONDecoder()) throws -> T {
        guard let body else {
            throw TransportError.invalidResponse(message: "No body data to decode")
        }
        return try decoder.decode(type, from: body)
    }

    /// Decode the body as a UTF-8 string.
    public var bodyString: String? {
        body.flatMap { String(data: $0, encoding: .utf8) }
    }
}
