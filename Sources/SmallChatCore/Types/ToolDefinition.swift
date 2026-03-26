public struct ToolDefinition: Sendable, Codable {
    public let name: String
    public let description: String
    public let inputSchema: JSONSchemaType
    public let providerId: String
    public let transportType: TransportType

    public init(
        name: String,
        description: String,
        inputSchema: JSONSchemaType,
        providerId: String,
        transportType: TransportType
    ) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
        self.providerId = providerId
        self.transportType = transportType
    }
}
