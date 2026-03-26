import Foundation

public struct UnrecognizedIntent: Error, Sendable, CustomStringConvertible {
    public let intent: String
    public let candidates: [String]

    public init(intent: String, candidates: [String] = []) {
        self.intent = intent
        self.candidates = candidates
    }

    public var description: String {
        var msg = "Unrecognized intent: \"\(intent)\""
        if !candidates.isEmpty {
            msg += ". Did you mean: \(candidates.joined(separator: ", "))?"
        }
        return msg
    }
}

public struct OverloadAmbiguityError: Error, Sendable, CustomStringConvertible {
    public let selector: String
    public let candidates: [String]

    public init(selector: String, candidates: [String]) {
        self.selector = selector
        self.candidates = candidates
    }

    public var description: String {
        "Ambiguous overload for selector \"\(selector)\": candidates are \(candidates.joined(separator: ", "))"
    }
}

public struct SignatureValidationError: Error, Sendable, CustomStringConvertible {
    public let toolName: String
    public let errors: [ValidationError]

    public init(toolName: String, errors: [ValidationError]) {
        self.toolName = toolName
        self.errors = errors
    }

    public var description: String {
        let details = errors.map { "\($0.path): \($0.message)" }.joined(separator: "; ")
        return "Signature validation failed for \"\(toolName)\": \(details)"
    }
}

public struct SelectorShadowingError: Error, Sendable, CustomStringConvertible {
    public let shadowedSelector: String
    public let shadowingProvider: String
    public let existingProvider: String

    public init(shadowedSelector: String, shadowingProvider: String, existingProvider: String) {
        self.shadowedSelector = shadowedSelector
        self.shadowingProvider = shadowingProvider
        self.existingProvider = existingProvider
    }

    public var description: String {
        "Selector \"\(shadowedSelector)\" from provider \"\(shadowingProvider)\" shadows existing selector from provider \"\(existingProvider)\""
    }
}

public struct VectorFloodError: Error, Sendable, CustomStringConvertible {
    public let currentSize: Int?
    public let maxSize: Int?
    public let canonical: String?

    public init(currentSize: Int, maxSize: Int) {
        self.currentSize = currentSize
        self.maxSize = maxSize
        self.canonical = nil
    }

    public init(canonical: String) {
        self.currentSize = nil
        self.maxSize = nil
        self.canonical = canonical
    }

    public var description: String {
        if let canonical = canonical {
            return "Semantic rate limit exceeded: too many high-entropy, low-similarity intents. "
                + "Intent \"\(canonical)\" was throttled to protect the embedder from DoS. "
                + "Wait for the current window to drain before retrying."
        }
        return "Vector index flood: current size \(currentSize ?? 0) exceeds maximum \(maxSize ?? 0)"
    }
}
