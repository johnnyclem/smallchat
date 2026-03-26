import Foundation

/// Handler type alias for local transport tool execution.
public typealias LocalHandler = @Sendable (TransportInput) async throws -> TransportOutput

/// Local function transport — executes handler closures in-process.
///
/// No network involved. Takes a handler closure and invokes it directly.
/// Supports per-tool handler registration and a fallback handler.
///
/// Mirrors the TypeScript `LocalTransport` class.
public actor LocalTransport: Transport {

    public nonisolated let id: String

    private var handlers: [String: LocalHandler] = [:]
    private var fallbackHandler: LocalHandler?
    private var connected: Bool = true

    private static var counter = 0

    /// Initialize with an optional fallback handler for unregistered tool names.
    public init(handler: LocalHandler? = nil) {
        Self.counter += 1
        self.id = "local-\(Self.counter)"
        self.fallbackHandler = handler
    }

    // MARK: - Handler Registration

    /// Register a handler for a specific tool name.
    public func registerHandler(toolName: String, handler: @escaping LocalHandler) {
        handlers[toolName] = handler
    }

    /// Remove a handler for a tool name. Returns `true` if one was removed.
    @discardableResult
    public func unregisterHandler(toolName: String) -> Bool {
        handlers.removeValue(forKey: toolName) != nil
    }

    /// Check if a handler is registered for a tool name.
    public func hasHandler(toolName: String) -> Bool {
        handlers[toolName] != nil || fallbackHandler != nil
    }

    // MARK: - Transport Protocol

    public nonisolated var isConnected: Bool {
        get async { await getConnected() }
    }

    private func getConnected() -> Bool { connected }

    public nonisolated func connect() async throws {}

    public nonisolated func disconnect() async throws {
        await performDisconnect()
    }

    private func performDisconnect() {
        handlers.removeAll()
        fallbackHandler = nil
        connected = false
    }

    public nonisolated func execute(input: TransportInput) async throws -> TransportOutput {
        let startTime = Date()

        do {
            guard let handler = await resolveHandler(for: input.toolName) else {
                throw TransportError.handlerNotFound(toolName: input.toolName)
            }

            let effectiveTimeout = input.timeout ?? 30

            let result: TransportOutput
            if effectiveTimeout > 0 {
                let middleware = TimeoutMiddleware(timeout: effectiveTimeout)
                result = try await middleware.execute {
                    try await handler(input)
                }
            } else {
                result = try await handler(input)
            }

            var output = result
            output.metadata["durationMs"] = String(Int(Date().timeIntervalSince(startTime) * 1000))
            return output
        } catch {
            var output = errorToTransportOutput(error)
            output.metadata["durationMs"] = String(Int(Date().timeIntervalSince(startTime) * 1000))
            return output
        }
    }

    // MARK: - Private

    private func resolveHandler(for toolName: String) -> LocalHandler? {
        handlers[toolName] ?? fallbackHandler
    }
}
