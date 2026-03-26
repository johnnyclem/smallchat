import Foundation

/// ToolClass -- a group of related tools from one provider.
/// Equivalent to an Objective-C class with dispatch table, protocols, superclass chain, and overload tables.
public final class ToolClass: @unchecked Sendable {
    public let name: String
    public private(set) var protocols: [ToolProtocolDef] = []
    public var dispatchTable: [String: any ToolIMP] = [:]
    public var overloadTables: [String: OverloadTable] = [:]
    public var superclass: ToolClass?

    public init(name: String) { self.name = name }

    /// Register a method (selector -> IMP mapping)
    public func addMethod(_ selector: ToolSelector, imp: any ToolIMP) {
        dispatchTable[selector.canonical] = imp
    }

    /// Register an overloaded method -- same selector, different signature.
    /// The first overload registered also becomes the default IMP in the dispatch table.
    public func addOverload(
        _ selector: ToolSelector,
        signature: SCMethodSignature,
        imp: any ToolIMP,
        originalToolName: String? = nil,
        isSemanticOverload: Bool = false
    ) throws {
        if overloadTables[selector.canonical] == nil {
            overloadTables[selector.canonical] = OverloadTable(selectorCanonical: selector.canonical)
        }
        try overloadTables[selector.canonical]!.register(
            signature,
            imp: imp,
            originalToolName: originalToolName,
            isSemanticOverload: isSemanticOverload
        )
        // First overload becomes the default IMP
        if dispatchTable[selector.canonical] == nil {
            dispatchTable[selector.canonical] = imp
        }
    }

    /// Declare conformance to a protocol
    public func addProtocol(_ proto: ToolProtocolDef) {
        protocols.append(proto)
    }

    /// Check protocol conformance
    public func conformsTo(_ proto: ToolProtocolDef) -> Bool {
        protocols.contains { $0.name == proto.name }
    }

    /// Resolve a selector by walking dispatch table and isa chain.
    /// Like Obj-C method resolution: own table -> superclass -> nil (triggers forwarding).
    public func resolveSelector(_ selector: ToolSelector) -> (any ToolIMP)? {
        if let direct = dispatchTable[selector.canonical] { return direct }
        return superclass?.resolveSelector(selector)
    }

    /// Resolve with positional args (overload resolution)
    public func resolveSelectorWithArgs(
        _ selector: ToolSelector,
        args: [any Sendable]
    ) throws -> OverloadResolutionResult? {
        if let table = overloadTables[selector.canonical], table.size > 0 {
            return try table.resolve(args)
        }
        return try superclass?.resolveSelectorWithArgs(selector, args: args)
    }

    /// Resolve with named args
    public func resolveSelectorWithNamedArgs(
        _ selector: ToolSelector,
        namedArgs: [String: any Sendable]
    ) throws -> OverloadResolutionResult? {
        if let table = overloadTables[selector.canonical], table.size > 0 {
            return try table.resolveNamed(namedArgs)
        }
        return try superclass?.resolveSelectorWithNamedArgs(selector, namedArgs: namedArgs)
    }

    /// Hardened resolve with validation (prevents Type Confusion)
    public func validateAndResolveSelectorWithNamedArgs(
        _ selector: ToolSelector,
        namedArgs: [String: any Sendable]
    ) throws -> OverloadResolutionResult? {
        if let table = overloadTables[selector.canonical], table.size > 0 {
            return try table.validateAndResolveNamed(namedArgs)
        }
        return try superclass?.validateAndResolveSelectorWithNamedArgs(selector, namedArgs: namedArgs)
    }

    /// Hardened resolve with positional args
    public func validateAndResolveSelectorWithArgs(
        _ selector: ToolSelector,
        args: [any Sendable]
    ) throws -> OverloadResolutionResult? {
        if let table = overloadTables[selector.canonical], table.size > 0 {
            return try table.validateAndResolve(args)
        }
        return try superclass?.validateAndResolveSelectorWithArgs(selector, args: args)
    }

    /// Check if a selector has overloads
    public func hasOverloads(_ selector: ToolSelector) -> Bool {
        guard let table = overloadTables[selector.canonical] else { return false }
        return table.size > 1
    }

    /// respondsToSelector: equivalent
    public func canHandle(_ selector: ToolSelector) -> Bool {
        resolveSelector(selector) != nil
    }

    /// All selectors this class responds to
    public func allSelectors() -> [String] {
        var selectors = Array(dispatchTable.keys)
        if let sup = superclass {
            selectors.append(contentsOf: sup.allSelectors())
        }
        return selectors
    }
}
