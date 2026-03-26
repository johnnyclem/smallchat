import SmallChatCore

// MARK: - Fallback Types

/// Fallback step in the forwarding chain
public struct FallbackStep: Sendable {
    public let strategy: FallbackStrategy
    public let tried: String
    public let result: FallbackResult

    public enum FallbackStrategy: String, Sendable {
        case superclass
        case broadenedSearch = "broadened_search"
        case llmDisambiguate = "llm_disambiguate"
    }

    public enum FallbackResult: String, Sendable {
        case hit
        case miss
    }

    public init(strategy: FallbackStrategy, tried: String, result: FallbackResult) {
        self.strategy = strategy
        self.tried = tried
        self.result = result
    }
}

/// Result of the fallback chain -- returned instead of throwing when no exact match is found.
public struct FallbackChainResult: Sendable {
    public let tool: String
    public let message: String
    public let intent: String
    public let nearestSelectors: [SelectorMatch]
    public let fallbackSteps: [FallbackStep]

    public init(
        tool: String,
        message: String,
        intent: String,
        nearestSelectors: [SelectorMatch],
        fallbackSteps: [FallbackStep]
    ) {
        self.tool = tool
        self.message = message
        self.intent = intent
        self.nearestSelectors = nearestSelectors
        self.fallbackSteps = fallbackSteps
    }
}

// MARK: - DispatchContext

/// DispatchContext -- the runtime context for tool dispatch.
///
/// Holds the selector table, resolution cache, tool classes (providers),
/// vector index, and protocol registry. This is the environment in which
/// toolkit_dispatch operates.
public actor DispatchContext {
    public let selectorTable: SelectorTable
    public let cache: ResolutionCache
    public let vectorIndex: any VectorIndex
    public let embedder: any Embedder
    public let selectorNamespace: SelectorNamespace
    public let intentPins: IntentPinRegistry

    private var toolClasses: [String: ToolClass] = [:]
    private var protocols: [String: ToolProtocolDef] = [:]
    /// All tool IMPs indexed by their selector canonical name
    private var toolIndex: [String: [ToolCandidate]] = [:]

    public init(
        selectorTable: SelectorTable,
        cache: ResolutionCache,
        vectorIndex: any VectorIndex,
        embedder: any Embedder,
        selectorNamespace: SelectorNamespace? = nil,
        intentPins: IntentPinRegistry? = nil
    ) {
        self.selectorTable = selectorTable
        self.cache = cache
        self.vectorIndex = vectorIndex
        self.embedder = embedder
        self.selectorNamespace = selectorNamespace ?? SelectorNamespace()
        self.intentPins = intentPins ?? IntentPinRegistry()
    }

    /// Register a provider (ToolClass).
    ///
    /// Throws SelectorShadowingError if the class contains selectors that
    /// would shadow protected core selectors.
    public func registerClass(_ toolClass: ToolClass) throws {
        // Guard: check all selectors in this class against the namespace
        let ownSelectors = Array(toolClass.dispatchTable.keys)
        try selectorNamespace.assertNoShadowing(toolClass.name, ownSelectors)

        toolClasses[toolClass.name] = toolClass

        // Index all methods for vector search
        for (canonical, imp) in toolClass.dispatchTable {
            let selector = await selectorTable.get(canonical)
            guard let selector else { continue }

            var candidates = toolIndex[canonical] ?? []
            candidates.append(ToolCandidate(imp: imp, confidence: 1.0, selector: selector))
            toolIndex[canonical] = candidates
        }
    }

    /// Register a protocol
    public func registerProtocol(_ proto: ToolProtocolDef) {
        protocols[proto.name] = proto
    }

    /// ISA chain -- check protocol conformance for a selector
    public func resolveViaProtocol(_ selector: ToolSelector) -> ToolCandidate? {
        for (_, toolClass) in toolClasses {
            for proto in toolClass.protocols {
                let isRequired = proto.requiredSelectors.contains {
                    $0.canonical == selector.canonical
                }
                let isOptional = proto.optionalSelectors.contains {
                    $0.canonical == selector.canonical
                }

                if isRequired || isOptional {
                    if let imp = toolClass.resolveSelector(selector) {
                        return ToolCandidate(imp: imp, confidence: 0.8, selector: selector)
                    }
                }
            }
        }
        return nil
    }

    /// Forwarding chain -- slow path when no compiled tool matches.
    ///
    /// Instead of throwing immediately, walks a fallback chain:
    ///  1. Superclass traversal -- check superclass dispatch tables across all classes
    ///  2. Broadened vector search -- lower the similarity threshold to find near-misses
    ///  3. LLM disambiguation stub -- placeholder for Phase 3 LLM-assisted resolution
    ///  4. Return a stub result inviting the caller to search, rather than crashing
    public func forward(
        _ selector: ToolSelector,
        intent: String,
        args: [String: any Sendable]?
    ) async throws -> ToolResult {
        var fallbackSteps: [FallbackStep] = []

        // Step 1: SUPERCLASS TRAVERSAL -- walk isa chains for a match
        for toolClass in getClasses() {
            guard let sup = toolClass.superclass else { continue }

            if let imp = sup.resolveSelector(selector) {
                fallbackSteps.append(FallbackStep(
                    strategy: .superclass,
                    tried: "\(toolClass.name) -> \(sup.name)",
                    result: .hit
                ))
                await cache.store(selector, imp: imp, confidence: 0.6)
                return try await executeWithArgs(imp, args: args ?? [:])
            }

            fallbackSteps.append(FallbackStep(
                strategy: .superclass,
                tried: "\(toolClass.name) -> \(sup.name)",
                result: .miss
            ))
        }

        // Step 2: BROADENED SEARCH -- lower threshold to find near-misses
        let broadMatches = try await vectorIndex.search(query: selector.vector, topK: 5, threshold: 0.5)
        if !broadMatches.isEmpty {
            for match in broadMatches {
                let matchSelector = await selectorTable.get(match.id)
                guard let matchSelector else { continue }

                for toolClass in getClasses() {
                    if let imp = toolClass.resolveSelector(matchSelector) {
                        fallbackSteps.append(FallbackStep(
                            strategy: .broadenedSearch,
                            tried: "\(match.id) (distance: \(String(format: "%.3f", match.distance)))",
                            result: .hit
                        ))
                        let confidence = Double(1 - match.distance)
                        await cache.store(selector, imp: imp, confidence: confidence)
                        return try await executeWithArgs(imp, args: args ?? [:])
                    }
                }
            }

            fallbackSteps.append(FallbackStep(
                strategy: .broadenedSearch,
                tried: broadMatches.map(\.id).joined(separator: ", "),
                result: .miss
            ))
        }

        // Step 3: LLM DISAMBIGUATION -- Phase 3 stub
        fallbackSteps.append(FallbackStep(
            strategy: .llmDisambiguate,
            tried: "LLM disambiguation (not yet implemented)",
            result: .miss
        ))

        // Step 4: Return a stub instead of throwing
        let nearest = try await vectorIndex.search(query: selector.vector, topK: 3, threshold: 0.5)

        let fallbackResult = FallbackChainResult(
            tool: "unknown",
            message: nearest.isEmpty
                ? "No match for \"\(intent)\"--want me to search?"
                : "No exact match for \"\(intent)\". Nearest: \(nearest.map(\.id).joined(separator: ", ")). Want me to search?",
            intent: intent,
            nearestSelectors: nearest,
            fallbackSteps: fallbackSteps
        )

        return ToolResult(
            content: AnyCodableValue.string(fallbackResult.message),
            isError: false,
            metadata: [
                "fallback": true as any Sendable,
                "stepsAttempted": fallbackSteps.count as any Sendable,
            ]
        )
    }

    /// Get all registered tool classes
    public func getClasses() -> [ToolClass] {
        Array(toolClasses.values)
    }
}
