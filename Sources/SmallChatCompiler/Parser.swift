import SmallChatCore

/// A parsed tool definition ready for compilation
public struct ParsedTool: Sendable {
    public let name: String
    public let description: String
    public let inputSchema: JSONSchemaType
    public let providerId: String
    public let transportType: TransportType
    public let arguments: [ArgumentSpec]
    /// Resolved compiler hints (merged from provider defaults + tool overrides)
    public let compilerHints: CompilerHint?
    /// Provider-level hints (carried for reference during compilation)
    public let providerHints: ProviderCompilerHints?

    public init(
        name: String,
        description: String,
        inputSchema: JSONSchemaType,
        providerId: String,
        transportType: TransportType,
        arguments: [ArgumentSpec],
        compilerHints: CompilerHint? = nil,
        providerHints: ProviderCompilerHints? = nil
    ) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
        self.providerId = providerId
        self.transportType = transportType
        self.arguments = arguments
        self.compilerHints = compilerHints
        self.providerHints = providerHints
    }
}

/// Merge provider-level compiler hints with tool-level overrides.
/// Tool-level values take precedence over provider-level defaults.
public func mergeCompilerHints(
    provider: ProviderCompilerHints?,
    tool: CompilerHint?
) -> CompilerHint? {
    guard provider != nil || tool != nil else { return nil }

    guard let provider = provider else { return tool }
    guard let tool = tool else {
        return CompilerHint(
            selectorHint: provider.selectorHint,
            priority: provider.priority
        )
    }

    return CompilerHint(
        selectorHint: tool.selectorHint ?? provider.selectorHint,
        pinSelector: tool.pinSelector,
        aliases: tool.aliases,
        priority: tool.priority ?? provider.priority,
        preferred: tool.preferred,
        exclude: tool.exclude,
        vendorMeta: tool.vendorMeta
    )
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

        let mergedHints = mergeCompilerHints(
            provider: manifest.compilerHints,
            tool: tool.compilerHints
        )

        return ParsedTool(
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            providerId: manifest.id,
            transportType: manifest.transportType,
            arguments: arguments,
            compilerHints: mergedHints,
            providerHints: manifest.compilerHints
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
