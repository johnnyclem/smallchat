import Foundation

/// An entry in the overload table
public struct OverloadEntry: @unchecked Sendable {
    public let signature: SCMethodSignature
    public let imp: any ToolIMP
    /// Original tool name (useful when overloads come from semantic grouping)
    public let originalToolName: String?
    /// Whether this overload was compiler-generated from semantic similarity
    public let isSemanticOverload: Bool

    public init(
        signature: SCMethodSignature,
        imp: any ToolIMP,
        originalToolName: String? = nil,
        isSemanticOverload: Bool = false
    ) {
        self.signature = signature
        self.imp = imp
        self.originalToolName = originalToolName
        self.isSemanticOverload = isSemanticOverload
    }
}

/// Result of overload resolution
public struct OverloadResolutionResult: @unchecked Sendable {
    public let imp: any ToolIMP
    public let signature: SCMethodSignature
    public let matchQuality: MatchQuality
    public let entry: OverloadEntry

    public init(
        imp: any ToolIMP,
        signature: SCMethodSignature,
        matchQuality: MatchQuality,
        entry: OverloadEntry
    ) {
        self.imp = imp
        self.signature = signature
        self.matchQuality = matchQuality
        self.entry = entry
    }
}

/// Maps a selector to multiple method signatures (like C++ overloading)
///
/// Resolution priority:
///   - Exact type match > superclass match > union match > any (id)
///   - Higher arity match preferred when scores are equal
///   - Ambiguous matches (equal score, same arity) reported as errors
public final class OverloadTable: @unchecked Sendable {
    public let selectorCanonical: String
    private var entries: [OverloadEntry] = []

    public init(selectorCanonical: String) {
        self.selectorCanonical = selectorCanonical
    }

    /// Register an overload for this selector.
    /// Throws if a duplicate signatureKey is already registered.
    public func register(
        _ signature: SCMethodSignature,
        imp: any ToolIMP,
        originalToolName: String? = nil,
        isSemanticOverload: Bool = false
    ) throws {
        let existing = entries.first { $0.signature.signatureKey == signature.signatureKey }
        if existing != nil {
            throw DuplicateOverloadError(
                selector: selectorCanonical,
                signatureKey: signature.signatureKey
            )
        }

        entries.append(OverloadEntry(
            signature: signature,
            imp: imp,
            originalToolName: originalToolName,
            isSemanticOverload: isSemanticOverload
        ))
    }

    /// Resolve the best matching overload for positional args.
    ///
    /// Arguments are passed as a positional array. Named arguments
    /// should be converted to positional form before calling this method.
    public func resolve(_ args: [any Sendable]) throws -> OverloadResolutionResult? {
        var bestScore = -1
        var bestEntries: [OverloadEntry] = []

        for entry in entries {
            let score = scoreSignatureMatch(entry.signature, args)
            if score < 0 { continue }

            if score > bestScore {
                bestScore = score
                bestEntries = [entry]
            } else if score == bestScore {
                bestEntries.append(entry)
            }
        }

        if bestEntries.isEmpty { return nil }

        if bestEntries.count > 1 {
            // Tiebreak: prefer higher arity (more specific match)
            bestEntries.sort { $0.signature.arity > $1.signature.arity }
            if bestEntries[0].signature.arity == bestEntries[1].signature.arity {
                // Prefer developer-defined over semantic overloads
                let devDefined = bestEntries.filter { !$0.isSemanticOverload }
                if devDefined.count == 1 {
                    bestEntries = devDefined
                } else {
                    let candidateNames = bestEntries.map {
                        $0.originalToolName ?? $0.signature.signatureKey
                    }
                    throw OverloadAmbiguityError(
                        selector: selectorCanonical,
                        candidates: candidateNames
                    )
                }
            }
        }

        let winner = bestEntries[0]
        let quality = deriveMatchQuality(bestScore, arity: winner.signature.arity)

        return OverloadResolutionResult(
            imp: winner.imp,
            signature: winner.signature,
            matchQuality: quality,
            entry: winner
        )
    }

    /// Resolve using named arguments by mapping them to positional form.
    public func resolveNamed(
        _ namedArgs: [String: any Sendable],
        signature: SCMethodSignature? = nil
    ) throws -> OverloadResolutionResult? {
        // If a specific signature is provided, convert to positional and resolve
        if let signature {
            let positional = namedToPositional(namedArgs, signature: signature)
            return try resolve(positional)
        }

        // Try all overloads with name-to-position mapping
        var bestResult: OverloadResolutionResult? = nil
        var bestScore = -1

        for entry in entries {
            let positional = namedToPositional(namedArgs, signature: entry.signature)
            let score = scoreSignatureMatch(entry.signature, positional)
            if score > bestScore {
                bestScore = score
                let quality = deriveMatchQuality(score, arity: entry.signature.arity)
                bestResult = OverloadResolutionResult(
                    imp: entry.imp,
                    signature: entry.signature,
                    matchQuality: quality,
                    entry: entry
                )
            }
        }

        return bestResult
    }

    /// Resolve AND strictly validate — the hardened dispatch path.
    ///
    /// 1. Resolves the best-matching overload (same as `resolve`)
    /// 2. Re-validates every argument against the winning signature's
    ///    type descriptors using strict `validateArgumentTypes`
    /// 3. Throws `SignatureValidationError` if any argument violates the
    ///    SCObject type hierarchy
    public func validateAndResolve(_ args: [any Sendable]) throws -> OverloadResolutionResult? {
        let result = try resolve(args)
        guard let result else { return nil }

        let validation = validateArgumentTypes(result.signature, args)
        if !validation.valid {
            throw SignatureValidationError(
                toolName: selectorCanonical,
                errors: validation.violations.map { violation in
                    ValidationError(
                        path: violation.parameterName,
                        message: "[\(violation.kind.rawValue)] expected \(violation.expected), received \(violation.received)",
                        expected: violation.expected,
                        received: violation.received
                    )
                }
            )
        }

        return result
    }

    /// Named-argument variant of validateAndResolve.
    ///
    /// Resolves overloads via named args, then strictly validates every
    /// argument against the winning signature's type hierarchy.
    public func validateAndResolveNamed(
        _ namedArgs: [String: any Sendable],
        signature: SCMethodSignature? = nil
    ) throws -> OverloadResolutionResult? {
        let result = try resolveNamed(namedArgs, signature: signature)
        guard let result else { return nil }

        let validation = validateNamedArgumentTypes(result.signature, namedArgs)
        if !validation.valid {
            throw SignatureValidationError(
                toolName: selectorCanonical,
                errors: validation.violations.map { violation in
                    ValidationError(
                        path: violation.parameterName,
                        message: "[\(violation.kind.rawValue)] expected \(violation.expected), received \(violation.received)",
                        expected: violation.expected,
                        received: violation.received
                    )
                }
            )
        }

        return result
    }

    /// Get all registered overloads
    public func allOverloads() -> [OverloadEntry] {
        entries
    }

    /// Number of registered overloads
    public var size: Int {
        entries.count
    }

    /// Check if a specific signature is registered
    public func hasSignature(_ key: String) -> Bool {
        entries.contains { $0.signature.signatureKey == key }
    }

    // MARK: - Private

    private func deriveMatchQuality(_ score: Int, arity: Int) -> MatchQuality {
        if arity == 0 { return .exact }
        let avg = Double(score) / Double(arity)
        if avg >= 4 { return .exact }
        if avg >= 3 { return .superclass }
        if avg >= 2 { return .union }
        return .any
    }
}

// MARK: - Helpers

/// Convert named arguments to positional form using a signature's parameter names.
func namedToPositional(
    _ namedArgs: [String: any Sendable],
    signature: SCMethodSignature
) -> [any Sendable] {
    var positional: [any Sendable] = Array(repeating: NSNull() as any Sendable, count: signature.arity)

    for slot in signature.parameters {
        if let value = namedArgs[slot.name] {
            positional[slot.position] = value
        } else if let defaultVal = slot.defaultValue {
            positional[slot.position] = defaultVal
        }
        // else: leave as NSNull — resolution will handle missing required
    }

    return positional
}

/// Error thrown when a duplicate overload is registered
public struct DuplicateOverloadError: Error, Sendable, CustomStringConvertible {
    public let selector: String
    public let signatureKey: String

    public init(selector: String, signatureKey: String) {
        self.selector = selector
        self.signatureKey = signatureKey
    }

    public var description: String {
        "Duplicate overload for \"\(selector)\" with signature \"\(signatureKey)\""
    }
}
