public struct ToolCategory: Sendable {
    public let name: String
    public let extendsProtocol: String
    public let methods: [ToolMethod]

    public init(name: String, extendsProtocol: String, methods: [ToolMethod] = []) {
        self.name = name
        self.extendsProtocol = extendsProtocol
        self.methods = methods
    }
}
