/// A specific function signature — combination of parameter types.
/// Multiple signatures can be registered for the same selector, forming overloads.
public struct SCMethodSignature: Sendable {
    public let parameters: [SCParameterSlot]
    public let arity: Int
    public let signatureKey: String

    public init(parameters: [SCParameterSlot]) {
        self.parameters = parameters
        self.arity = parameters.count
        self.signatureKey = Self.buildKey(parameters)
    }

    private static func buildKey(_ params: [SCParameterSlot]) -> String {
        guard !params.isEmpty else { return "void" }
        return params.map { Self.typeDescriptorToKey($0.type) }.joined(separator: ":")
    }

    private static func typeDescriptorToKey(_ type: SCTypeDescriptor) -> String {
        switch type {
        case .primitive(let p):
            return p.rawValue
        case .object(let className):
            return className
        case .union(let types):
            return "(\(types.map { typeDescriptorToKey($0) }.joined(separator: "|")))"
        case .any:
            return "id"
        }
    }
}

/// Create a signature from parameter slots
public func createSignature(_ params: [SCParameterSlot]) -> SCMethodSignature {
    SCMethodSignature(parameters: params)
}
