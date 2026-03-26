import Foundation

public final class SCObjectRegistry: Sendable {
    public static let shared = SCObjectRegistry()

    private let lock: OSAllocatedUnfairLock<RegistryState>

    struct RegistryState: Sendable {
        var classes: [String: String?] = ["SCObject": nil]
        var hierarchyCache: [String: [String]] = ["SCObject": ["SCObject"]]
    }

    private init() {
        self.lock = OSAllocatedUnfairLock(initialState: RegistryState())
    }

    public func register(_ name: String, superclass: String) {
        lock.withLock { state in
            state.classes[name] = superclass
            var chain: [String] = []
            var current: String? = name
            while let c = current {
                chain.append(c)
                current = state.classes[c] ?? nil
            }
            state.hierarchyCache[name] = chain
        }
    }

    public func isSubclass(_ name: String, of parent: String) -> Bool {
        lock.withLock { state in
            state.hierarchyCache[name]?.contains(parent) ?? false
        }
    }

    public func hierarchy(_ name: String) -> [String] {
        lock.withLock { state in
            state.hierarchyCache[name] ?? []
        }
    }
}
