public struct CompilationResult: Sendable {
    public var selectors: [String: ToolSelector]
    public var dispatchTables: [String: [String: any ToolIMP]]
    public var protocols: [ToolProtocolDef]
    public var toolCount: Int
    public var uniqueSelectorCount: Int
    public var mergedCount: Int
    public var collisions: [SelectorCollision]
    public var overloadTables: [String: OverloadTableData]
    public var semanticOverloads: [SemanticOverloadGroup]

    public init(
        selectors: [String: ToolSelector] = [:],
        dispatchTables: [String: [String: any ToolIMP]] = [:],
        protocols: [ToolProtocolDef] = [],
        toolCount: Int = 0,
        uniqueSelectorCount: Int = 0,
        mergedCount: Int = 0,
        collisions: [SelectorCollision] = [],
        overloadTables: [String: OverloadTableData] = [:],
        semanticOverloads: [SemanticOverloadGroup] = []
    ) {
        self.selectors = selectors
        self.dispatchTables = dispatchTables
        self.protocols = protocols
        self.toolCount = toolCount
        self.uniqueSelectorCount = uniqueSelectorCount
        self.mergedCount = mergedCount
        self.collisions = collisions
        self.overloadTables = overloadTables
        self.semanticOverloads = semanticOverloads
    }
}

public struct SelectorCollision: Sendable, Codable {
    public let selectorA: String
    public let selectorB: String
    public let similarity: Double
    public let hint: String

    public init(
        selectorA: String,
        selectorB: String,
        similarity: Double,
        hint: String
    ) {
        self.selectorA = selectorA
        self.selectorB = selectorB
        self.similarity = similarity
        self.hint = hint
    }
}

public struct OverloadTableData: Sendable, Codable {
    public let selectorCanonical: String
    public let overloads: [OverloadEntryData]

    public init(selectorCanonical: String, overloads: [OverloadEntryData] = []) {
        self.selectorCanonical = selectorCanonical
        self.overloads = overloads
    }
}

public struct OverloadEntryData: Sendable, Codable {
    public let signatureKey: String
    public let parameterNames: [String]
    public let parameterTypes: [String]
    public let arity: Int
    public let toolName: String
    public let providerId: String
    public let isSemanticOverload: Bool

    public init(
        signatureKey: String,
        parameterNames: [String],
        parameterTypes: [String],
        arity: Int,
        toolName: String,
        providerId: String,
        isSemanticOverload: Bool = false
    ) {
        self.signatureKey = signatureKey
        self.parameterNames = parameterNames
        self.parameterTypes = parameterTypes
        self.arity = arity
        self.toolName = toolName
        self.providerId = providerId
        self.isSemanticOverload = isSemanticOverload
    }
}

public struct SemanticOverloadGroup: Sendable {
    public let canonicalSelector: String
    public let tools: [GroupedTool]
    public let reason: String

    public init(canonicalSelector: String, tools: [GroupedTool], reason: String) {
        self.canonicalSelector = canonicalSelector
        self.tools = tools
        self.reason = reason
    }

    public struct GroupedTool: Sendable {
        public let providerId: String
        public let toolName: String
        public let similarity: Double

        public init(providerId: String, toolName: String, similarity: Double) {
            self.providerId = providerId
            self.toolName = toolName
            self.similarity = similarity
        }
    }
}
