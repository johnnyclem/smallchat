public struct ToolSchema: Sendable, Codable {
    public let name: String
    public let description: String
    public let inputSchema: JSONSchemaType
    public let arguments: [ArgumentSpec]

    public init(
        name: String,
        description: String,
        inputSchema: JSONSchemaType,
        arguments: [ArgumentSpec] = []
    ) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
        self.arguments = arguments
    }
}
