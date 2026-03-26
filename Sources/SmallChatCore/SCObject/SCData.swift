public final class SCData: SCObject {
    private static let registered: Bool = {
        SCObjectRegistry.shared.register("SCData", superclass: "SCObject")
        return true
    }()

    public let value: [String: any Sendable]

    override public var isa: String { "SCData" }

    public init(value: [String: any Sendable]) {
        self.value = value
        super.init()
        _ = Self.registered
    }

    public func get(_ key: String) -> (any Sendable)? {
        value[key]
    }

    public func has(_ key: String) -> Bool {
        value.keys.contains(key)
    }

    public func keys() -> [String] {
        Array(value.keys)
    }

    override public var description: String {
        let keyList = keys().prefix(5).joined(separator: ", ")
        let suffix = keys().count > 5 ? "..." : ""
        return "<SCData id=\(id) keys=[\(keyList)\(suffix)]>"
    }

    override public func unwrap() -> any Sendable {
        value
    }
}
