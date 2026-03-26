import SmallChatCore

// MARK: - Resolution Outcome

/// Resolution outcome -- either a resolved IMP ready for execution,
/// or a forwarded ToolResult from the fallback chain (no IMP to execute).
enum ResolutionOutcome: @unchecked Sendable {
    case resolved(imp: any ToolIMP, confidence: Double, selector: ToolSelector, candidates: [ToolCandidate])
    case forwarded(result: ToolResult)
}

// MARK: - Shared Resolution Logic

/// resolveToolIMP -- shared resolution logic for both sync and streaming dispatch.
///
/// Resolution order:
///  1. Selector resolve (embed + intern)
///  1a. Intent pin exact match fast path
///  2. Cache lookup (skip when args present for overload cases)
///  3. Vector similarity search (top 5, threshold 0.75)
///     - Intent pin guard on candidates
///     - Overload resolution with validation
///     - Dispatch table resolve
///  4. Cache fallback for overloaded case
///  5a. ISA chain / protocol conformance
///  5b. Forwarding chain
func resolveToolIMP(
    context: DispatchContext,
    intent: String,
    args: [String: any Sendable]? = nil
) async throws -> ResolutionOutcome {
    // 1. RESOLVE SELECTOR (embed + intern)
    let selector = try await context.selectorTable.resolve(intent)
    let intentCanonical = canonicalize(intent)

    // 1a. INTENT PIN -- exact match fast path
    if context.intentPins.size > 0 {
        let exactPinMatch = context.intentPins.checkExact(intentCanonical)
        if let exactPinMatch, exactPinMatch.verdict == .accept {
            let pinnedSelector = await context.selectorTable.get(exactPinMatch.canonical)
            if let pinnedSelector {
                for toolClass in await context.getClasses() {
                    let imp = toolClass.resolveSelector(pinnedSelector)
                    if let imp {
                        await context.cache.store(selector, imp: imp, confidence: 1.0)
                        return .resolved(
                            imp: imp,
                            confidence: 1.0,
                            selector: pinnedSelector,
                            candidates: []
                        )
                    }
                }
            }
        }
    }

    // 2. CHECK CACHE (the inline cache / method cache)
    // Skip cache when args are provided and overloads may exist -- type matters
    let hasArgs = args != nil && !(args!.isEmpty)
    if !hasArgs {
        let cached = await context.cache.lookup(selector)
        if let cached {
            return .resolved(
                imp: cached.imp,
                confidence: cached.confidence,
                selector: selector,
                candidates: []
            )
        }
    }

    // 3. SEARCH DISPATCH TABLE (vector similarity)
    let matches = try await context.vectorIndex.search(query: selector.vector, topK: 5, threshold: 0.75)
    var candidates: [ToolCandidate] = []

    for match in matches {
        let matchSelector = await context.selectorTable.get(match.id)
        guard let matchSelector else { continue }

        // 3.PIN: INTENT PIN -- guard pinned candidates against semantic collision
        if context.intentPins.size > 0 {
            let pinCheck = context.intentPins.checkSimilarity(
                candidateCanonical: match.id,
                similarity: Double(1 - match.distance),
                intentCanonical: intentCanonical
            )
            if let pinCheck {
                if pinCheck.verdict == .reject {
                    // This candidate is pinned and the intent doesn't meet the policy --
                    // skip it so it cannot be dispatched via semantic bridging
                    continue
                }
                // verdict == .accept -- proceed with normal dispatch
            }
        }

        for toolClass in await context.getClasses() {
            // 3a. OVERLOAD RESOLUTION -- if args exist and overloads are registered
            if hasArgs, toolClass.hasOverloads(matchSelector) {
                let overloadResult = try toolClass.validateAndResolveSelectorWithNamedArgs(
                    matchSelector,
                    namedArgs: args!
                )
                if let overloadResult {
                    await context.cache.store(selector, imp: overloadResult.imp, confidence: Double(1 - match.distance))
                    return .resolved(
                        imp: overloadResult.imp,
                        confidence: Double(1 - match.distance),
                        selector: matchSelector,
                        candidates: []
                    )
                }
            }

            let imp = toolClass.resolveSelector(matchSelector)
            if let imp {
                candidates.append(ToolCandidate(
                    imp: imp,
                    confidence: Double(1 - match.distance),
                    selector: matchSelector
                ))
            }
        }
    }

    // Also check cache for non-overloaded case when args were provided
    if hasArgs {
        let cached = await context.cache.lookup(selector)
        if let cached {
            return .resolved(
                imp: cached.imp,
                confidence: cached.confidence,
                selector: selector,
                candidates: []
            )
        }
    }

    if candidates.isEmpty {
        // 4a. ISA CHAIN -- check protocol conformance
        let protocolMatch = await context.resolveViaProtocol(selector)
        if let protocolMatch {
            await context.cache.store(selector, imp: protocolMatch.imp, confidence: protocolMatch.confidence)
            return .resolved(
                imp: protocolMatch.imp,
                confidence: protocolMatch.confidence,
                selector: protocolMatch.selector,
                candidates: []
            )
        }

        // 4b. FORWARDING -- slow path
        let result = try await context.forward(selector, intent: intent, args: args)
        return .forwarded(result: result)
    }

    // Sort by confidence descending
    let sorted = candidates.sorted { $0.confidence > $1.confidence }
    let best = sorted[0]
    await context.cache.store(selector, imp: best.imp, confidence: best.confidence)

    return .resolved(
        imp: best.imp,
        confidence: best.confidence,
        selector: best.selector,
        candidates: sorted
    )
}

// MARK: - toolkit_dispatch

/// toolkit_dispatch -- the hot path. Equivalent to objc_msgSend.
///
/// Uses resolveToolIMP for resolution, then executes synchronously.
public func toolkitDispatch(
    context: DispatchContext,
    intent: String,
    args: [String: any Sendable]? = nil
) async throws -> ToolResult {
    let outcome = try await resolveToolIMP(context: context, intent: intent, args: args)

    switch outcome {
    case .forwarded(let result):
        return result

    case .resolved(let imp, let confidence, _, let candidates):
        var result = try await executeWithArgs(imp, args: args ?? [:])

        // Annotate ambiguous results so callers know disambiguation may be needed
        if candidates.count > 1, confidence <= 0.90 {
            var meta = result.metadata ?? [:]
            meta["ambiguous"] = true as any Sendable
            meta["candidateCount"] = candidates.count as any Sendable
            let topCandidates: [[String: any Sendable]] = candidates.prefix(3).map { c in
                [
                    "tool": c.imp.toolName as any Sendable,
                    "confidence": c.confidence as any Sendable,
                ]
            }
            meta["topCandidates"] = topCandidates as any Sendable
            result.metadata = meta
        }

        return result
    }
}

// MARK: - smallchat_dispatchStream

/// smallchat_dispatchStream -- async stream variant of toolkit_dispatch.
///
/// Yields DispatchEvent objects for real-time UI feedback:
///   1. "resolving" -- immediately, so the caller knows work has started
///   2. "tool-start" -- once a tool is resolved, before execution
///   3. "chunk" / "inference-delta" -- incremental content from the tool
///   4. "done" -- final result with the complete ToolResult
///   5. "error" -- if anything goes wrong at any stage
public func smallchatDispatchStream(
    context: DispatchContext,
    intent: String,
    args: [String: any Sendable]? = nil
) -> AsyncThrowingStream<DispatchEvent, Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            continuation.yield(.resolving(intent: intent))

            let outcome: ResolutionOutcome
            do {
                outcome = try await resolveToolIMP(context: context, intent: intent, args: args)
            } catch {
                var metadata: [String: AnyCodableValue]? = nil

                if let err = error as? SignatureValidationError {
                    metadata = [
                        "typeConfusionGuard": .bool(true),
                        "toolName": .string(err.toolName),
                    ]
                } else if let err = error as? VectorFloodError {
                    metadata = [
                        "throttled": .bool(true),
                        "reason": .string("vector-flooding"),
                    ]
                    _ = err
                }

                continuation.yield(.error(
                    message: String(describing: error),
                    metadata: metadata
                ))
                continuation.finish()
                return
            }

            switch outcome {
            case .forwarded(let result):
                continuation.yield(.done(result: result))
                continuation.finish()

            case .resolved(let imp, let confidence, let selector, _):
                continuation.yield(.toolStart(
                    toolName: imp.toolName,
                    providerId: imp.providerId,
                    confidence: confidence,
                    selector: selector.canonical
                ))

                do {
                    try await executeAndStream(imp: imp, args: args ?? [:], continuation: continuation)
                } catch {
                    continuation.yield(.error(
                        message: String(describing: error),
                        metadata: nil
                    ))
                }
                continuation.finish()
            }
        }

        continuation.onTermination = { _ in
            task.cancel()
        }
    }
}

// MARK: - executeWithArgs

/// Execute an IMP with arguments, unwrapping any SCObject values
/// back to their underlying representations.
func executeWithArgs(
    _ imp: any ToolIMP,
    args: [String: any Sendable]
) async throws -> ToolResult {
    var unwrapped: [String: any Sendable] = [:]
    for (key, value) in args {
        unwrapped[key] = unwrapValue(value)
    }
    return try await imp.execute(args: unwrapped)
}

// MARK: - executeAndStream

/// Execute a tool and stream its result at the finest granularity the
/// IMP supports. Resolution order:
///
///   1. executeInference  -- token-level deltas (OpenAI / Anthropic SSE)
///   2. executeStream     -- chunk-level results
///   3. execute           -- single-shot fallback
///
/// Each tier falls through to the next, so every IMP works -- providers
/// that expose a raw inference stream get true progressive output.
private func executeAndStream(
    imp: any ToolIMP,
    args: [String: any Sendable],
    continuation: AsyncThrowingStream<DispatchEvent, Error>.Continuation
) async throws {
    var unwrapped: [String: any Sendable] = [:]
    for (key, value) in args {
        unwrapped[key] = unwrapValue(value)
    }

    // ---- Tier 1: Progressive inference (token-level) ----
    if let inferenceImp = imp as? any InferenceIMP {
        var tokenIndex = 0
        var parts: [String] = []

        for try await delta in inferenceImp.executeInference(args: unwrapped) {
            continuation.yield(.inferenceDelta(delta: delta, tokenIndex: tokenIndex))
            parts.append(delta.text)
            tokenIndex += 1
        }

        // Synthesise a final ToolResult from the accumulated tokens
        let assembled = parts.joined()
        let result = ToolResult(content: assembled)
        continuation.yield(.chunk(content: .string(assembled), index: 0))
        continuation.yield(.done(result: result))
        return
    }

    // ---- Tier 2: Chunk-level streaming ----
    if let streamableImp = imp as? any StreamableIMP {
        var index = 0
        var lastResult: ToolResult?

        for try await chunk in streamableImp.executeStream(args: unwrapped) {
            if let content = chunk.content {
                let codable = anyCodableFromSendable(content)
                continuation.yield(.chunk(content: codable, index: index))
            }
            index += 1
            lastResult = chunk
        }

        continuation.yield(.done(result: lastResult ?? ToolResult(content: nil)))
        return
    }

    // ---- Tier 3: Single-shot fallback ----
    let result = try await imp.execute(args: unwrapped)
    if let content = result.content {
        let codable = anyCodableFromSendable(content)
        continuation.yield(.chunk(content: codable, index: 0))
    }
    continuation.yield(.done(result: result))
}

// MARK: - Helpers

/// Best-effort conversion from `any Sendable` to `AnyCodableValue`.
private func anyCodableFromSendable(_ value: any Sendable) -> AnyCodableValue {
    if let codable = value as? AnyCodableValue { return codable }
    if let s = value as? String { return .string(s) }
    if let i = value as? Int { return .int(i) }
    if let d = value as? Double { return .double(d) }
    if let b = value as? Bool { return .bool(b) }
    return .string(String(describing: value))
}
