import Foundation

/// The universal transport protocol.
///
/// Every transport implementation (HTTP, MCP stdio/SSE, local function) conforms
/// to this protocol. The runtime dispatches through it without knowing the
/// underlying protocol, keeping tool resolution and execution cleanly separated.
///
/// Mirrors the TypeScript `ITransport` interface.
public protocol Transport: Sendable {

    /// Unique identifier for this transport instance.
    var id: String { get }

    /// Execute a request and return a single response.
    func execute(input: TransportInput) async throws -> TransportOutput

    /// Execute a request and return a stream of responses.
    ///
    /// Default implementation calls `execute` once and yields the single result.
    func executeStream(input: TransportInput) -> AsyncThrowingStream<TransportOutput, Error>

    /// Whether the transport is currently connected and ready.
    var isConnected: Bool { get async }

    /// Establish the transport connection (e.g., spawn process, open socket).
    func connect() async throws

    /// Gracefully shut down the transport (close connections, kill processes).
    func disconnect() async throws
}

// MARK: - Default Implementations

extension Transport {

    /// Default streaming implementation: execute once and yield the result.
    public func executeStream(input: TransportInput) -> AsyncThrowingStream<TransportOutput, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    let output = try await self.execute(input: input)
                    continuation.yield(output)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    /// Default: always connected (stateless transports).
    public var isConnected: Bool {
        get async { true }
    }

    /// Default no-op connect.
    public func connect() async throws {}

    /// Default no-op disconnect.
    public func disconnect() async throws {}
}
