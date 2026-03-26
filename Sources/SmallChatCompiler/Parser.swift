import SmallChatCore

/// A parsed tool definition ready for compilation
public struct ParsedTool: Sendable {
    public let name: String
    public let description: String
    public let inputSchema: JSONSchemaType
    public let providerId: String
    public let transportType: TransportType
    public let arguments: [ArgumentSpec]

    public init(
        name: String,
        description: String,
        inputSchema: JSONSchemaType,
        providerId: String,
        transportType: TransportType,
        arguments: [ArgumentSpec]
    ) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
        self.providerId = providerId
        self.transportType = transportType
        self.arguments = arguments
    }
}

/// Parse an MCP-format provider manifest into individual tool definitions
public func parseMCPManifest(_ manifest: ProviderManifest) -> [ParsedTool] {
    manifest.tools.map { tool in
        // Extract argument specs from inputSchema properties
        var arguments: [ArgumentSpec] = []
        if let props = tool.inputSchema.properties {
            let requiredSet = Set(tool.inputSchema.required ?? [])
            for (name, schema) in props.sorted(by: { $0.key < $1.key }) {
                arguments.append(ArgumentSpec(
                    name: name,
                    type: schema,
                    description: schema.description ?? "",
                    enumValues: schema.enumValues,
                    defaultValue: schema.defaultValue,
                    required: requiredSet.contains(name)
                ))
            }
        }

        return ParsedTool(
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            providerId: manifest.id,
            transportType: manifest.transportType,
            arguments: arguments
        )
    }
}

/// Parse an OpenAPI spec (simplified -- takes tool definitions directly)
public func parseOpenAPISpec(_ tools: [ToolDefinition]) -> [ParsedTool] {
    tools.map { tool in
        var arguments: [ArgumentSpec] = []
        if let props = tool.inputSchema.properties {
            let requiredSet = Set(tool.inputSchema.required ?? [])
            for (name, schema) in props.sorted(by: { $0.key < $1.key }) {
                arguments.append(ArgumentSpec(
                    name: name,
                    type: schema,
                    description: schema.description ?? "",
                    enumValues: nil,
                    defaultValue: nil,
                    required: requiredSet.contains(name)
                ))
            }
        }
        return ParsedTool(
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            providerId: tool.providerId,
            transportType: tool.transportType,
            arguments: arguments
        )
    }
}

/// Parse raw schema format
public func parseRawSchema(_ tools: [ToolDefinition]) -> [ParsedTool] {
    parseOpenAPISpec(tools)
}
