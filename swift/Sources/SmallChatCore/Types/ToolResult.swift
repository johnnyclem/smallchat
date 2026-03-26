public struct ToolResult: Sendable {
    public var content: (any Sendable)?
    public var isError: Bool
    public var metadata: [String: any Sendable]?

    public init(
        content: (any Sendable)? = nil,
        isError: Bool = false,
        metadata: [String: any Sendable]? = nil
    ) {
        self.content = content
        self.isError = isError
        self.metadata = metadata
    }

    /// Convenience initializer using AnyCodableValue for Codable content.
    public init(
        codableContent: AnyCodableValue,
        isError: Bool = false,
        metadata: [String: AnyCodableValue]? = nil
    ) {
        self.content = codableContent
        self.isError = isError
        if let metadata {
            var m: [String: any Sendable] = [:]
            for (k, v) in metadata { m[k] = v }
            self.metadata = m
        } else {
            self.metadata = nil
        }
    }
}
