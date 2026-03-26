import Foundation

/// ToolProxy -- lazy-loaded tool that loads its full schema only on first dispatch.
/// Equivalent to NSProxy: exists as lightweight stand-in until first message.
public actor ToolProxy: ToolIMP {
    public nonisolated let providerId: String
    public nonisolated let toolName: String
    public nonisolated let transportType: TransportType

    private var _schema: ToolSchema?
    private let schemaLoader: @Sendable () async throws -> ToolSchema
    private var realized: Bool = false

    public var schema: ToolSchema? { _schema }

    public init(
        providerId: String,
        toolName: String,
        transportType: TransportType,
        schemaLoader: @escaping @Sendable () async throws -> ToolSchema
    ) {
        self.providerId = providerId
        self.toolName = toolName
        self.transportType = transportType
        self.schemaLoader = schemaLoader
    }

    private func realize() async throws {
        guard !realized else { return }
        _schema = try await schemaLoader()
        realized = true
    }

    public func loadSchema() async throws -> ToolSchema {
        try await realize()
        return _schema!
    }

    public func execute(args: [String: any Sendable]) async throws -> ToolResult {
        try await realize()
        // In a full implementation, this would route through a transport
        // For now, return a placeholder indicating the tool was called
        return ToolResult(
            content: AnyCodableValue.dict(["tool": .string(toolName), "status": .string("executed")]),
            isError: false,
            metadata: nil
        )
    }
}
