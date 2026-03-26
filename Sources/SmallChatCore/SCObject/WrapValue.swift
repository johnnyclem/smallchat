public func wrapValue(_ value: any Sendable) -> any Sendable {
    if value is SCObject { return value }
    if let dict = value as? [String: any Sendable] {
        return SCData(value: dict)
    }
    if let arr = value as? [any Sendable] {
        let items = arr.map { item -> SCObject in
            let wrapped = wrapValue(item)
            if let obj = wrapped as? SCObject { return obj }
            return SCData(value: ["value": wrapped])
        }
        return SCArray(items: items)
    }
    // Primitives (String, Int, Double, Bool) pass through as-is
    return value
}

public func unwrapValue(_ value: any Sendable) -> any Sendable {
    if let obj = value as? SCObject { return obj.unwrap() }
    return value
}
