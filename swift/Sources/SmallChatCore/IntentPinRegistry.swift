import Foundation

public enum IntentPinPolicy: String, Sendable {
    case exact
    case elevated
}

public struct IntentPin: Sendable {
    public let canonical: String
    public let policy: IntentPinPolicy
    public let threshold: Double?
    public let aliases: [String]?

    public init(
        canonical: String,
        policy: IntentPinPolicy,
        threshold: Double? = nil,
        aliases: [String]? = nil
    ) {
        self.canonical = canonical
        self.policy = policy
        self.threshold = threshold
        self.aliases = aliases
    }
}

public struct IntentPinMatch: Sendable {
    public let canonical: String
    public let verdict: Verdict
    public let policy: IntentPinPolicy
    public let similarity: Double?
    public let requiredThreshold: Double?

    public enum Verdict: String, Sendable {
        case accept
        case reject
    }

    public init(
        canonical: String,
        verdict: Verdict,
        policy: IntentPinPolicy,
        similarity: Double? = nil,
        requiredThreshold: Double? = nil
    ) {
        self.canonical = canonical
        self.verdict = verdict
        self.policy = policy
        self.similarity = similarity
        self.requiredThreshold = requiredThreshold
    }
}

/// Default elevated-policy threshold
private let defaultElevatedThreshold: Double = 0.98

/// Guards sensitive selectors against semantic collision attacks.
/// Lock-based for synchronous reads on the dispatch hot path.
public final class IntentPinRegistry: Sendable {
    private let lock: OSAllocatedUnfairLock<State>

    struct State: Sendable {
        var pins: [String: IntentPin] = [:]
        var aliasIndex: [String: String] = [:]  // alias canonical -> pin canonical
    }

    public init() {
        self.lock = OSAllocatedUnfairLock(initialState: State())
    }

    /// Pin a selector with a given policy.
    public func pin(_ entry: IntentPin) {
        lock.withLock { state in
            state.pins[entry.canonical] = entry

            // Index aliases
            if let aliases = entry.aliases {
                for alias in aliases {
                    let aliasCanonical = canonicalize(alias)
                    state.aliasIndex[aliasCanonical] = entry.canonical
                }
            }
        }
    }

    /// Remove a pin.
    public func unpin(_ canonical: String) {
        lock.withLock { state in
            if let existing = state.pins[canonical], let aliases = existing.aliases {
                for alias in aliases {
                    state.aliasIndex.removeValue(forKey: canonicalize(alias))
                }
            }
            state.pins.removeValue(forKey: canonical)
        }
    }

    /// Check if a selector canonical name is pinned.
    public func isPinned(_ canonical: String) -> Bool {
        lock.withLock { state in
            state.pins[canonical] != nil
        }
    }

    /// Get the pin entry for a canonical name.
    public func getPin(_ canonical: String) -> IntentPin? {
        lock.withLock { state in
            state.pins[canonical]
        }
    }

    /// Number of pinned selectors.
    public var size: Int {
        lock.withLock { state in
            state.pins.count
        }
    }

    /// All pinned canonicals.
    public func pinnedCanonicals() -> [String] {
        lock.withLock { state in
            Array(state.pins.keys)
        }
    }

    /// Check an intent against pins for exact canonical match.
    /// Returns nil if the intent doesn't interact with any pinned selector.
    public func checkExact(_ intentCanonical: String) -> IntentPinMatch? {
        lock.withLock { state in
            // Direct canonical match against a pinned selector
            if let directPin = state.pins[intentCanonical] {
                return IntentPinMatch(
                    canonical: directPin.canonical,
                    verdict: .accept,
                    policy: directPin.policy
                )
            }

            // Check alias index
            if let aliasTarget = state.aliasIndex[intentCanonical],
               let pin = state.pins[aliasTarget] {
                return IntentPinMatch(
                    canonical: pin.canonical,
                    verdict: .accept,
                    policy: pin.policy
                )
            }

            return nil
        }
    }

    /// Check whether a vector similarity match to a pinned selector should be accepted/rejected.
    public func checkSimilarity(
        candidateCanonical: String,
        similarity: Double,
        intentCanonical: String
    ) -> IntentPinMatch? {
        lock.withLock { state in
            guard let pin = state.pins[candidateCanonical] else { return nil }

            if pin.policy == .exact {
                // Exact policy: only accept if canonical strings match exactly (or via alias)
                let isExactMatch =
                    intentCanonical == candidateCanonical ||
                    state.aliasIndex[intentCanonical] == candidateCanonical

                return IntentPinMatch(
                    canonical: pin.canonical,
                    verdict: isExactMatch ? .accept : .reject,
                    policy: .exact
                )
            }

            if pin.policy == .elevated {
                let threshold = pin.threshold ?? defaultElevatedThreshold
                return IntentPinMatch(
                    canonical: pin.canonical,
                    verdict: similarity >= threshold ? .accept : .reject,
                    policy: .elevated,
                    similarity: similarity,
                    requiredThreshold: threshold
                )
            }

            return nil
        }
    }
}
