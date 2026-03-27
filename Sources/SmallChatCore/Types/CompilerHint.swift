/// CompilerHint — an optional directive attached to a tool that influences
/// how the compiler maps it into the selector table.
///
/// Analogous to `__attribute__((objc_direct))` or `NS_SWIFT_NAME()` — metadata
/// that doesn't change what a tool *does*, but steers how it's compiled.
public struct CompilerHint: Sendable, Codable, Equatable {
    /// Additional semantic text appended to the tool description during embedding.
    public let selectorHint: String?

    /// Pin this tool to a specific canonical selector, bypassing vector-based interning.
    public let pinSelector: String?

    /// Semantic aliases — additional intent phrases that should resolve to this tool.
    public let aliases: [String]?

    /// Priority multiplier for dispatch ranking (default 1.0).
    public let priority: Double?

    /// Mark this tool as the preferred resolution when multiple tools collide.
    public let preferred: Bool?

    /// Exclude this tool from compilation entirely.
    public let exclude: Bool?

    /// Vendor-defined opaque metadata.
    public let vendorMeta: [String: AnyCodable]?

    public init(
        selectorHint: String? = nil,
        pinSelector: String? = nil,
        aliases: [String]? = nil,
        priority: Double? = nil,
        preferred: Bool? = nil,
        exclude: Bool? = nil,
        vendorMeta: [String: AnyCodable]? = nil
    ) {
        self.selectorHint = selectorHint
        self.pinSelector = pinSelector
        self.aliases = aliases
        self.priority = priority
        self.preferred = preferred
        self.exclude = exclude
        self.vendorMeta = vendorMeta
    }
}

/// ProviderCompilerHints — hints applied at the provider (MCP server) level.
public struct ProviderCompilerHints: Sendable, Codable, Equatable {
    /// Default priority multiplier for all tools from this provider.
    public let priority: Double?

    /// Namespace prefix prepended to all selector canonicals.
    public let namespace: String?

    /// Semantic context appended to ALL tool descriptions during embedding.
    public let selectorHint: String?

    /// Vendor-defined opaque metadata.
    public let vendorMeta: [String: AnyCodable]?

    public init(
        priority: Double? = nil,
        namespace: String? = nil,
        selectorHint: String? = nil,
        vendorMeta: [String: AnyCodable]? = nil
    ) {
        self.priority = priority
        self.namespace = namespace
        self.selectorHint = selectorHint
        self.vendorMeta = vendorMeta
    }
}

/// A type-erased Codable wrapper for vendor metadata values.
public struct AnyCodable: Sendable, Codable, Equatable {
    public let value: Any

    public init(_ value: Any) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            value = string
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            value = NSNull()
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let string as String: try container.encode(string)
        case let int as Int: try container.encode(int)
        case let double as Double: try container.encode(double)
        case let bool as Bool: try container.encode(bool)
        default: try container.encodeNil()
        }
    }

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        switch (lhs.value, rhs.value) {
        case (let l as String, let r as String): return l == r
        case (let l as Int, let r as Int): return l == r
        case (let l as Double, let r as Double): return l == r
        case (let l as Bool, let r as Bool): return l == r
        default: return false
        }
    }
}
