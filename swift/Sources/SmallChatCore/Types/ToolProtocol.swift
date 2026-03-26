public struct ToolProtocolDef: Sendable {
    public let name: String
    public let embedding: [Float]
    public let requiredSelectors: [ToolSelector]
    public let optionalSelectors: [ToolSelector]

    public init(
        name: String,
        embedding: [Float],
        requiredSelectors: [ToolSelector],
        optionalSelectors: [ToolSelector] = []
    ) {
        self.name = name
        self.embedding = embedding
        self.requiredSelectors = requiredSelectors
        self.optionalSelectors = optionalSelectors
    }
}
