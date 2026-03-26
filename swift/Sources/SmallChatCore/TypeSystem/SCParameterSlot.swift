/// A single positional parameter in a function signature.
public struct SCParameterSlot: Sendable {
    public let name: String
    public let position: Int
    public let type: SCTypeDescriptor
    public let required: Bool
    public let defaultValue: (any Sendable)?

    public init(
        name: String,
        position: Int,
        type: SCTypeDescriptor,
        required: Bool = true,
        defaultValue: (any Sendable)? = nil
    ) {
        self.name = name
        self.position = position
        self.type = type
        self.required = required
        self.defaultValue = defaultValue
    }
}

/// Convenience builder (matches TypeScript's `param` function)
public func param(
    _ name: String,
    _ position: Int,
    _ type: SCTypeDescriptor,
    required: Bool = true,
    defaultValue: (any Sendable)? = nil
) -> SCParameterSlot {
    SCParameterSlot(
        name: name,
        position: position,
        type: type,
        required: required,
        defaultValue: defaultValue
    )
}
