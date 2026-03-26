public struct ToolSelector: Sendable, Equatable, Hashable {
    public let vector: [Float]
    public let canonical: String
    public let parts: [String]
    public let arity: Int

    public init(
        vector: [Float],
        canonical: String,
        parts: [String],
        arity: Int
    ) {
        self.vector = vector
        self.canonical = canonical
        self.parts = parts
        self.arity = arity
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(canonical)
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.canonical == rhs.canonical
    }
}
