import Foundation

/// Check if a runtime value matches a type descriptor. Returns the quality of the match.
public func matchType(_ value: any Sendable, _ type: SCTypeDescriptor) -> MatchQuality {
    switch type {
    case .any:
        return .any

    case .primitive(let primitiveType):
        switch primitiveType {
        case .string:
            return value is String ? .exact : .none
        case .number:
            // Bool conforms to numeric protocols in Swift, so check Bool first
            if value is Bool { return .none }
            return (value is Int || value is Double || value is Float) ? .exact : .none
        case .boolean:
            return value is Bool ? .exact : .none
        case .null:
            return value is NSNull ? .exact : .none
        }

    case .object(let className):
        guard let obj = value as? SCObject else { return .none }
        if obj.isa == className { return .exact }
        if SCObjectRegistry.shared.isSubclass(obj.isa, of: className) { return .superclass }
        return .none

    case .union(let types):
        var best: MatchQuality = .none
        for subType in types {
            let quality = matchType(value, subType)
            if quality > best {
                best = quality
            }
        }
        // Matches via union are capped at .union quality
        return best == .none ? .none : .union
    }
}

/// Score a full argument list against a signature.
/// Returns total quality score (higher is better) or -1 if no match.
public func scoreSignatureMatch(
    _ signature: SCMethodSignature,
    _ args: [any Sendable]
) -> Int {
    let requiredCount = signature.parameters.filter(\.required).count
    if args.count < requiredCount { return -1 }
    if args.count > signature.arity { return -1 }

    var totalScore = 0

    for i in 0..<signature.arity {
        let slot = signature.parameters[i]
        if i >= args.count {
            // Missing optional arg — ok if not required
            if slot.required { return -1 }
            continue
        }

        let quality = matchType(args[i], slot.type)
        if quality == .none { return -1 }
        totalScore += quality.rawValue
    }

    return totalScore
}

/// Infer an SCTypeDescriptor from a runtime value.
public func inferType(_ value: any Sendable) -> SCTypeDescriptor {
    if value is NSNull { return .primitive(.null) }
    if value is Bool { return .primitive(.boolean) }
    if value is String { return .primitive(.string) }
    if value is Int || value is Double || value is Float { return .primitive(.number) }
    if let obj = value as? SCObject { return .object(className: obj.isa) }
    return .any
}
