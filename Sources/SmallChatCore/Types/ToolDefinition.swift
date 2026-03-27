public struct ToolDefinition: Sendable, Codable {
    public let name: String
    public let description: String
    public let inputSchema: JSONSchemaType
    public let providerId: String
    public let transportType: TransportType
    /// Optional compiler hints that steer semantic mapping for this tool
    public let compilerHints: CompilerHint?

    public init(
        name: String,
        description: String,
        inputSchema: JSONSchemaType,
        providerId: String,
        transportType: TransportType,
        compilerHints: CompilerHint? = nil
    ) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
        self.providerId = providerId
        self.transportType = transportType
        self.compilerHints = compilerHints
    }
}
