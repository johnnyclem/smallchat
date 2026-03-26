/// Describes what type a parameter slot accepts.
/// Bridges JSON Schema primitives with SCObject class types.
public enum SCPrimitiveType: String, Sendable, Codable, Equatable {
    case string
    case number
    case boolean
    case null
}

public indirect enum SCTypeDescriptor: Sendable, Equatable {
    case primitive(SCPrimitiveType)
    case object(className: String)   // Matches a specific SCObject subclass
    case union([SCTypeDescriptor])   // Matches any of the listed types
    case any                         // id — accepts anything
}

/// Convenience constructors (matching TypeScript's SCType namespace)
public enum SCType {
    public static func string() -> SCTypeDescriptor { .primitive(.string) }
    public static func number() -> SCTypeDescriptor { .primitive(.number) }
    public static func boolean() -> SCTypeDescriptor { .primitive(.boolean) }
    public static func null() -> SCTypeDescriptor { .primitive(.null) }
    public static func object(_ className: String) -> SCTypeDescriptor { .object(className: className) }
    public static func union(_ types: SCTypeDescriptor...) -> SCTypeDescriptor { .union(types) }
    public static func any() -> SCTypeDescriptor { .any }
}
