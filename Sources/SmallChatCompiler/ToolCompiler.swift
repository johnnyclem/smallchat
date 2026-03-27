import SmallChatCore

/// ToolCompiler -- build-time tool that produces dispatch tables, selector tables, etc.
/// Pipeline: PARSE -> EMBED -> LINK -> OUTPUT
public struct ToolCompiler: Sendable {
    private let embedder: any Embedder
    private let vectorIndex: any VectorIndex
    private let options: CompilerOptions

    public init(embedder: any Embedder, vectorIndex: any VectorIndex, options: CompilerOptions = CompilerOptions()) {
        self.embedder = embedder
        self.vectorIndex = vectorIndex
        self.options = options
    }

    /// Compile tool definitions from provider manifests
    public func compile(_ manifests: [ProviderManifest]) async throws -> CompilationResult {
        // Phase 1: PARSE
        var allTools: [ParsedTool] = []
        for manifest in manifests {
            allTools.append(contentsOf: parseMCPManifest(manifest))
        }

        // Filter out tools marked as excluded via compiler hints
        allTools = allTools.filter { $0.compilerHints?.exclude != true }

        // Phase 2: EMBED
        // Compiler hints steer this phase:
        //   - selectorHint: appended to embedding text
        //   - pinSelector: bypasses vector interning entirely
        //   - aliases: additional selectors pointing to the same IMP
        let selectorTable = SelectorTable(
            index: vectorIndex,
            embedder: embedder,
            threshold: Float(options.deduplicationThreshold)
        )
        var toolSelectors: [Int: ToolSelector] = [:]
        var toolEmbeddings: [Int: [Float]] = [:]
        var aliasSelectors: [Int: [ToolSelector]] = [:]
        var mergedCount = 0

        for (i, tool) in allTools.enumerated() {
            // Build embedding text — selectorHint steers the vector
            var embeddingText = "\(tool.name): \(tool.description)"
            if let hint = tool.compilerHints?.selectorHint {
                embeddingText += " \(hint)"
            }

            // Determine canonical — pinSelector overrides the default
            let namespace = tool.providerHints?.namespace
            let defaultCanonical = namespace.map { "\($0).\(tool.name)" } ?? "\(tool.providerId).\(tool.name)"
            let canonical = tool.compilerHints?.pinSelector ?? defaultCanonical

            let embedding = try await embedder.embed(embeddingText)
            toolEmbeddings[i] = embedding
            let sizeBefore = await selectorTable.size
            let selector = try await selectorTable.intern(embedding: embedding, canonical: canonical)
            let sizeAfter = await selectorTable.size

            if sizeAfter == sizeBefore { mergedCount += 1 }
            toolSelectors[i] = selector

            // Process aliases
            if let aliases = tool.compilerHints?.aliases, !aliases.isEmpty {
                var aliasSels: [ToolSelector] = []
                for alias in aliases {
                    let aliasEmbedding = try await embedder.embed(alias)
                    let aliasCanonical = "\(canonical)~alias~\(alias.replacingOccurrences(of: " ", with: "_"))"
                    let aliasSel = try await selectorTable.intern(embedding: aliasEmbedding, canonical: aliasCanonical)
                    aliasSels.append(aliasSel)
                }
                aliasSelectors[i] = aliasSels
            }
        }

        // Phase 2.5: SEMANTIC OVERLOAD GENERATION (optional)
        var overloadTables: [String: OverloadTableData] = [:]
        var semanticOverloads: [SemanticOverloadGroup] = []

        if options.generateSemanticOverloads {
            let groups = findSemanticGroups(
                tools: allTools,
                embeddings: toolEmbeddings,
                threshold: options.semanticOverloadThreshold
            )

            for group in groups {
                let canonicalSelector = "\(group.tools[0].providerId).\(group.tools[0].name)"
                var overloadEntries: [OverloadEntryData] = []

                for tool in group.tools {
                    let slots = toolArgsToParameterSlots(tool)
                    let sig = createSignature(slots)
                    overloadEntries.append(OverloadEntryData(
                        signatureKey: sig.signatureKey,
                        parameterNames: slots.map(\.name),
                        parameterTypes: slots.map { typeDescriptorToString($0.type) },
                        arity: sig.arity,
                        toolName: tool.name,
                        providerId: tool.providerId,
                        isSemanticOverload: true
                    ))
                }

                overloadTables[canonicalSelector] = OverloadTableData(
                    selectorCanonical: canonicalSelector,
                    overloads: overloadEntries
                )

                semanticOverloads.append(SemanticOverloadGroup(
                    canonicalSelector: canonicalSelector,
                    tools: group.tools.enumerated().map { i, t in
                        SemanticOverloadGroup.GroupedTool(
                            providerId: t.providerId,
                            toolName: t.name,
                            similarity: i == 0 ? 1.0 : group.similarities[i - 1]
                        )
                    },
                    reason: "Tools grouped by semantic similarity above \(Int(options.semanticOverloadThreshold * 100))% threshold"
                ))
            }
        }

        // Phase 3: LINK
        var dispatchTables: [String: [String: any ToolIMP]] = [:]
        var collisions: [SelectorCollision] = []

        // Group tools by provider
        var providerTools: [String: [(Int, ParsedTool)]] = [:]
        for (i, tool) in allTools.enumerated() {
            providerTools[tool.providerId, default: []].append((i, tool))
        }

        // Build dispatch table per provider
        for (providerId, tools) in providerTools {
            var table: [String: any ToolIMP] = [:]
            for (i, tool) in tools {
                guard let selector = toolSelectors[i] else { continue }
                let imp = createIMP(tool)
                table[selector.canonical] = imp

                // Wire alias selectors to the same IMP
                if let aliases = aliasSelectors[i] {
                    for aliasSel in aliases {
                        table[aliasSel.canonical] = imp
                    }
                }
            }
            dispatchTables[providerId] = table
        }

        // Detect selector collisions
        let allSelectors = await selectorTable.all()
        let overloadedCanonicals = Set(overloadTables.keys)

        for i in 0..<allSelectors.count {
            for j in (i + 1)..<allSelectors.count {
                let a = allSelectors[i], b = allSelectors[j]
                if overloadedCanonicals.contains(a.canonical) || overloadedCanonicals.contains(b.canonical) {
                    continue
                }

                let similarity = Double(cosineSimilarity(a.vector, b.vector))
                if similarity > options.collisionThreshold && similarity < 0.95 {
                    collisions.append(SelectorCollision(
                        selectorA: a.canonical,
                        selectorB: b.canonical,
                        similarity: similarity,
                        hint: "Disambiguation needed: \"\(a.canonical)\" and \"\(b.canonical)\" are similar (\(String(format: "%.1f", similarity * 100))%)."
                    ))
                }
            }
        }

        return CompilationResult(
            selectors: Dictionary(uniqueKeysWithValues: allSelectors.map { ($0.canonical, $0) }),
            dispatchTables: dispatchTables,
            protocols: [],
            toolCount: allTools.count,
            uniqueSelectorCount: await selectorTable.size,
            mergedCount: mergedCount,
            collisions: collisions,
            overloadTables: overloadTables,
            semanticOverloads: semanticOverloads
        )
    }

    /// Build ToolClass instances from a compilation result
    public func buildClasses(_ result: CompilationResult) -> [ToolClass] {
        var classes: [ToolClass] = []
        for (providerId, table) in result.dispatchTables {
            let toolClass = ToolClass(name: providerId)
            for (canonical, imp) in table {
                if let selector = result.selectors[canonical] {
                    toolClass.addMethod(selector, imp: imp)
                }
            }
            classes.append(toolClass)
        }
        return classes
    }

    private func createIMP(_ tool: ParsedTool) -> ToolProxy {
        ToolProxy(
            providerId: tool.providerId,
            toolName: tool.name,
            transportType: tool.transportType,
            schemaLoader: { [tool] in
                ToolSchema(
                    name: tool.name,
                    description: tool.description,
                    inputSchema: JSONSchemaType(type: "object"),
                    arguments: tool.arguments
                )
            }
        )
    }
}

private func typeDescriptorToString(_ type: SCTypeDescriptor) -> String {
    switch type {
    case .primitive(let p): return p.rawValue
    case .object(let className): return className
    case .union(let types): return types.map { typeDescriptorToString($0) }.joined(separator: " | ")
    case .any: return "id"
    }
}
