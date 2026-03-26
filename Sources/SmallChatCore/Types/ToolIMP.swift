public protocol ToolIMP: AnyObject, Sendable {
    var providerId: String { get }
    var toolName: String { get }
    var transportType: TransportType { get }
    var schema: ToolSchema? { get }

    func loadSchema() async throws -> ToolSchema
    func execute(args: [String: any Sendable]) async throws -> ToolResult
}

public protocol StreamableIMP: ToolIMP {
    func executeStream(args: [String: any Sendable]) -> AsyncThrowingStream<ToolResult, Error>
}

public protocol InferenceIMP: StreamableIMP {
    func executeInference(args: [String: any Sendable]) -> AsyncThrowingStream<InferenceDelta, Error>
}
