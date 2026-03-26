import Foundation

private let idGenerator = OSAllocatedUnfairLock(initialState: 0)
private func nextId() -> Int {
    idGenerator.withLock { state in
        state += 1
        return state
    }
}

open class SCObject: @unchecked Sendable, CustomStringConvertible {
    public let id: Int

    open var isa: String { "SCObject" }

    public init() {
        self.id = nextId()
    }

    /// NSObject -isKindOfClass: -- true if this is an instance of className or any subclass
    public func isKindOfClass(_ className: String) -> Bool {
        SCObjectRegistry.shared.isSubclass(isa, of: className)
    }

    /// NSObject -isMemberOfClass: -- true only if this is exactly the given class
    public func isMemberOfClass(_ className: String) -> Bool {
        isa == className
    }

    /// NSObject -respondsToSelector: equivalent
    open func respondsToSelector(_ selectorCanonical: String) -> Bool {
        false
    }

    /// LLM-readable string representation
    public var description: String {
        "<\(isa) id=\(id)>"
    }

    /// Unwrap to the underlying value for IMP execution
    open func unwrap() -> any Sendable {
        self
    }
}
