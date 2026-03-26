public enum DispatchEvent: Sendable {
    case resolving(intent: String)
    case toolStart(toolName: String, providerId: String, confidence: Double, selector: String)
    case chunk(content: AnyCodableValue, index: Int)
    case inferenceDelta(delta: InferenceDelta, tokenIndex: Int)
    case done(result: ToolResult)
    case error(message: String, metadata: [String: AnyCodableValue]?)
}
