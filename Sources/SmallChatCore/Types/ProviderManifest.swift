public struct ProviderManifest: Sendable, Codable {
    public let id: String
    public let name: String
    public let tools: [ToolDefinition]
    public let transportType: TransportType
    public let endpoint: String?
    public let version: String?
    /// Provider-level compiler hints — defaults for all tools in this manifest
    public let compilerHints: ProviderCompilerHints?
    public let channel: ChannelInfo?

    public init(
        id: String,
        name: String,
        tools: [ToolDefinition],
        transportType: TransportType,
        endpoint: String? = nil,
        version: String? = nil,
        compilerHints: ProviderCompilerHints? = nil,
        channel: ChannelInfo? = nil
    ) {
        self.id = id
        self.name = name
        self.tools = tools
        self.transportType = transportType
        self.endpoint = endpoint
        self.version = version
        self.compilerHints = compilerHints
        self.channel = channel
    }

    public struct ChannelInfo: Sendable, Codable {
        public let isChannel: Bool
        public let twoWay: Bool
        public let permissionRelay: Bool
        public let replyToolName: String?
        public let instructions: String?

        public init(
            isChannel: Bool,
            twoWay: Bool = false,
            permissionRelay: Bool = false,
            replyToolName: String? = nil,
            instructions: String? = nil
        ) {
            self.isChannel = isChannel
            self.twoWay = twoWay
            self.permissionRelay = permissionRelay
            self.replyToolName = replyToolName
            self.instructions = instructions
        }
    }
}
