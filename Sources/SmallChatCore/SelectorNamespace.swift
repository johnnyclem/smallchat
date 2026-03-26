import Foundation

/// Entry for a protected core selector
public struct CoreSelectorEntry: Sendable {
    public let canonical: String
    public let ownerClass: String
    public var swizzlable: Bool

    public init(canonical: String, ownerClass: String, swizzlable: Bool = false) {
        self.canonical = canonical
        self.ownerClass = ownerClass
        self.swizzlable = swizzlable
    }
}

/// Guards core system selectors from being shadowed by plugins.
/// Uses lock-based synchronization for synchronous reads on the dispatch hot path.
public final class SelectorNamespace: Sendable {
    private let lock: OSAllocatedUnfairLock<[String: CoreSelectorEntry]>

    public init() {
        self.lock = OSAllocatedUnfairLock(initialState: [:])
    }

    /// Register a selector as a core system selector.
    public func registerCore(_ canonical: String, ownerClass: String, swizzlable: Bool = false) {
        lock.withLock { state in
            state[canonical] = CoreSelectorEntry(
                canonical: canonical,
                ownerClass: ownerClass,
                swizzlable: swizzlable
            )
        }
    }

    /// Register multiple selectors as core for a given owner class.
    public func registerCoreSelectors(
        _ ownerClass: String,
        selectors: [(canonical: String, swizzlable: Bool)]
    ) {
        lock.withLock { state in
            for (canonical, swizzlable) in selectors {
                state[canonical] = CoreSelectorEntry(
                    canonical: canonical,
                    ownerClass: ownerClass,
                    swizzlable: swizzlable
                )
            }
        }
    }

    /// Mark an existing core selector as swizzlable. Returns false if not registered.
    public func markSwizzlable(_ canonical: String) -> Bool {
        lock.withLock { state in
            guard var entry = state[canonical] else { return false }
            entry.swizzlable = true
            state[canonical] = entry
            return true
        }
    }

    /// Mark an existing core selector as non-swizzlable (protected). Returns false if not registered.
    public func markProtected(_ canonical: String) -> Bool {
        lock.withLock { state in
            guard var entry = state[canonical] else { return false }
            entry.swizzlable = false
            state[canonical] = entry
            return true
        }
    }

    /// Check whether a selector would shadow a protected core selector.
    /// Returns nil if not core or if swizzlable; returns the entry if blocked.
    public func checkShadowing(_ canonical: String) -> CoreSelectorEntry? {
        lock.withLock { state in
            guard let entry = state[canonical] else { return nil }
            if entry.swizzlable { return nil }
            return entry
        }
    }

    /// Throws SelectorShadowingError if any selector would shadow a protected core selector.
    public func assertNoShadowing(_ classname: String, _ selectors: [String]) throws {
        try lock.withLock { state in
            for canonical in selectors {
                guard let entry = state[canonical] else { continue }
                if entry.swizzlable { continue }
                if entry.ownerClass == classname { continue }
                throw SelectorShadowingError(
                    shadowedSelector: canonical,
                    shadowingProvider: classname,
                    existingProvider: entry.ownerClass
                )
            }
        }
    }

    /// Check if a selector is registered as core.
    public func isCore(_ canonical: String) -> Bool {
        lock.withLock { state in
            state[canonical] != nil
        }
    }

    /// Check if a core selector is swizzlable.
    public func isSwizzlable(_ canonical: String) -> Bool {
        lock.withLock { state in
            state[canonical]?.swizzlable ?? false
        }
    }

    /// Get the core selector entry, if any.
    public func getEntry(_ canonical: String) -> CoreSelectorEntry? {
        lock.withLock { state in
            state[canonical]
        }
    }

    /// Remove a selector from core protection. Returns true if it was registered.
    public func unregisterCore(_ canonical: String) -> Bool {
        lock.withLock { state in
            state.removeValue(forKey: canonical) != nil
        }
    }

    /// Number of registered core selectors.
    public var size: Int {
        lock.withLock { state in
            state.count
        }
    }

    /// All registered core selectors.
    public func allCore() -> [CoreSelectorEntry] {
        lock.withLock { state in
            Array(state.values)
        }
    }
}
