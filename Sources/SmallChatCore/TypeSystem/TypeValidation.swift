import Foundation

/// A single type violation found during strict signature validation.
public struct SignatureViolation: Sendable, Equatable {
    public let parameterName: String
    public let position: Int
    public let expected: String
    public let received: String
    public let kind: ViolationKind

    public enum ViolationKind: String, Sendable, Equatable {
        case typeMismatch = "type_mismatch"
        case missingRequired = "missing_required"
        case excessArgument = "excess_argument"
        case isaViolation = "isa_violation"
    }

    public init(
        parameterName: String,
        position: Int,
        expected: String,
        received: String,
        kind: ViolationKind
    ) {
        self.parameterName = parameterName
        self.position = position
        self.expected = expected
        self.received = received
        self.kind = kind
    }
}

/// Result of strict signature validation.
public struct SignatureValidationResult: Sendable {
    public let valid: Bool
    public let violations: [SignatureViolation]

    public init(valid: Bool, violations: [SignatureViolation]) {
        self.valid = valid
        self.violations = violations
    }
}

/// Describe a type descriptor in human-readable form.
func describeType(_ type: SCTypeDescriptor) -> String {
    switch type {
    case .primitive(let p):
        return p.rawValue
    case .object(let className):
        return className
    case .union(let types):
        return types.map { describeType($0) }.joined(separator: " | ")
    case .any:
        return "any"
    }
}

/// Describe the runtime type of a value in human-readable form.
func describeValueType(_ value: any Sendable) -> String {
    if value is NSNull { return "null" }
    if value is Bool { return "boolean" }
    if value is String { return "string" }
    if value is Int || value is Double || value is Float { return "number" }
    if let obj = value as? SCObject { return obj.isa }
    return String(describing: Swift.type(of: value))
}

/// Strictly validate an argument list against a method signature.
public func validateArgumentTypes(
    _ signature: SCMethodSignature,
    _ args: [any Sendable]
) -> SignatureValidationResult {
    var violations: [SignatureViolation] = []

    // Check for excess arguments beyond the signature's arity
    if args.count > signature.arity {
        for i in signature.arity..<args.count {
            violations.append(SignatureViolation(
                parameterName: "arg[\(i)]",
                position: i,
                expected: "(no parameter)",
                received: describeValueType(args[i]),
                kind: .excessArgument
            ))
        }
    }

    for i in 0..<signature.arity {
        let slot = signature.parameters[i]

        // Missing required argument
        if i >= args.count {
            if slot.required && slot.defaultValue == nil {
                violations.append(SignatureViolation(
                    parameterName: slot.name,
                    position: i,
                    expected: describeType(slot.type),
                    received: "undefined",
                    kind: .missingRequired
                ))
            }
            continue
        }

        let value = args[i]
        let quality = matchType(value, slot.type)

        if quality == .none {
            // Determine if this is specifically an isa hierarchy violation
            let isIsaViolation: Bool
            if case .object = slot.type, value is SCObject {
                isIsaViolation = true
            } else {
                isIsaViolation = false
            }

            violations.append(SignatureViolation(
                parameterName: slot.name,
                position: i,
                expected: describeType(slot.type),
                received: describeValueType(value),
                kind: isIsaViolation ? .isaViolation : .typeMismatch
            ))
        }
    }

    return SignatureValidationResult(
        valid: violations.isEmpty,
        violations: violations
    )
}

/// Strictly validate named arguments against a method signature.
public func validateNamedArgumentTypes(
    _ signature: SCMethodSignature,
    _ namedArgs: [String: any Sendable]
) -> SignatureValidationResult {
    var violations: [SignatureViolation] = []
    let knownNames = Set(signature.parameters.map(\.name))

    // Check for unknown argument names (potential injection/confusion vector)
    for name in namedArgs.keys {
        if !knownNames.contains(name) {
            violations.append(SignatureViolation(
                parameterName: name,
                position: -1,
                expected: "(not a parameter)",
                received: describeValueType(namedArgs[name]!),
                kind: .excessArgument
            ))
        }
    }

    // Build positional array and validate types
    var positional: [any Sendable] = Array(repeating: NSNull() as any Sendable, count: signature.arity)
    var populated = Set<Int>()

    for slot in signature.parameters {
        if let value = namedArgs[slot.name] {
            positional[slot.position] = value
            populated.insert(slot.position)
        } else if let defaultVal = slot.defaultValue {
            positional[slot.position] = defaultVal
            populated.insert(slot.position)
        }
    }

    let effectiveCount: Int
    if let maxPopulated = populated.max() {
        effectiveCount = maxPopulated + 1
    } else {
        effectiveCount = 0
    }

    let effectiveArgs = Array(positional.prefix(effectiveCount))
    let positionalResult = validateArgumentTypes(signature, effectiveArgs)
    violations.append(contentsOf: positionalResult.violations)

    return SignatureValidationResult(
        valid: violations.isEmpty,
        violations: violations
    )
}
