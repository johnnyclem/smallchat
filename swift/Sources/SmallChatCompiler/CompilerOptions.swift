public struct CompilerOptions: Sendable {
    public var collisionThreshold: Double
    public var deduplicationThreshold: Double
    public var generateSemanticOverloads: Bool
    public var semanticOverloadThreshold: Double

    public init(
        collisionThreshold: Double = 0.89,
        deduplicationThreshold: Double = 0.95,
        generateSemanticOverloads: Bool = false,
        semanticOverloadThreshold: Double = 0.82
    ) {
        self.collisionThreshold = collisionThreshold
        self.deduplicationThreshold = deduplicationThreshold
        self.generateSemanticOverloads = generateSemanticOverloads
        self.semanticOverloadThreshold = semanticOverloadThreshold
    }
}
