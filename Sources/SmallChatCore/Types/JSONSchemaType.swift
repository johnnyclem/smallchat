// MARK: - AnyCodableValue

public enum AnyCodableValue: Sendable, Codable, Equatable, Hashable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([AnyCodableValue])
    case dict([String: AnyCodableValue])

    // MARK: Codable

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
            return
        }
        if let b = try? container.decode(Bool.self) {
            self = .bool(b)
            return
        }
        if let i = try? container.decode(Int.self) {
            self = .int(i)
            return
        }
        if let d = try? container.decode(Double.self) {
            self = .double(d)
            return
        }
        if let s = try? container.decode(String.self) {
            self = .string(s)
            return
        }
        if let arr = try? container.decode([AnyCodableValue].self) {
            self = .array(arr)
            return
        }
        if let dict = try? container.decode([String: AnyCodableValue].self) {
            self = .dict(dict)
            return
        }

        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "AnyCodableValue cannot decode value"
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .int(let i): try container.encode(i)
        case .double(let d): try container.encode(d)
        case .bool(let b): try container.encode(b)
        case .null: try container.encodeNil()
        case .array(let arr): try container.encode(arr)
        case .dict(let dict): try container.encode(dict)
        }
    }
}

// MARK: - Box (indirect wrapper for recursive Codable struct)

public final class Box<T: Sendable & Codable & Equatable>: Sendable, Codable, Equatable {
    public let value: T

    public init(_ value: T) {
        self.value = value
    }

    public static func == (lhs: Box<T>, rhs: Box<T>) -> Bool {
        lhs.value == rhs.value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.value = try container.decode(T.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}

// MARK: - JSONSchemaType

public struct JSONSchemaType: Sendable, Codable, Equatable {
    public var type: String
    public var description: String?
    public var enumValues: [AnyCodableValue]?
    public var items: Box<JSONSchemaType>?
    public var properties: [String: JSONSchemaType]?
    public var required: [String]?
    public var defaultValue: AnyCodableValue?

    public init(
        type: String,
        description: String? = nil,
        enumValues: [AnyCodableValue]? = nil,
        items: JSONSchemaType? = nil,
        properties: [String: JSONSchemaType]? = nil,
        required: [String]? = nil,
        defaultValue: AnyCodableValue? = nil
    ) {
        self.type = type
        self.description = description
        self.enumValues = enumValues
        self.items = items.map { Box($0) }
        self.properties = properties
        self.required = required
        self.defaultValue = defaultValue
    }

    enum CodingKeys: String, CodingKey {
        case type
        case description
        case enumValues = "enum"
        case items
        case properties
        case required
        case defaultValue = "default"
    }
}
