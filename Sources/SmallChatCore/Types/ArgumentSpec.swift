public struct ArgumentSpec: Sendable, Codable, Equatable {
    public let name: String
    public let type: JSONSchemaType
    public let description: String
    public let enumValues: [AnyCodableValue]?
    public let defaultValue: AnyCodableValue?
    public let required: Bool

    public init(
        name: String,
        type: JSONSchemaType,
        description: String,
        enumValues: [AnyCodableValue]? = nil,
        defaultValue: AnyCodableValue? = nil,
        required: Bool = false
    ) {
        self.name = name
        self.type = type
        self.description = description
        self.enumValues = enumValues
        self.defaultValue = defaultValue
        self.required = required
    }

    enum CodingKeys: String, CodingKey {
        case name
        case type
        case description
        case enumValues = "enum"
        case defaultValue = "default"
        case required
    }
}
