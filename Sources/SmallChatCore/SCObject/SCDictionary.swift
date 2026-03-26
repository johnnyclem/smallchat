public final class SCDictionary: SCObject, @unchecked Sendable {
    private static let registered: Bool = {
        SCObjectRegistry.shared.register("SCDictionary", superclass: "SCObject")
        return true
    }()

    private var entries: [String: SCObject]

    override public var isa: String { "SCDictionary" }

    public init(entries: [String: SCObject] = [:]) {
        self.entries = entries
        super.init()
        _ = Self.registered
    }

    public var count: Int { entries.count }

    public func objectForKey(_ key: String) -> SCObject? {
        entries[key]
    }

    public func setObject(_ key: String, obj: SCObject) {
        entries[key] = obj
    }

    public func allKeys() -> [String] {
        Array(entries.keys)
    }

    public func allValues() -> [SCObject] {
        Array(entries.values)
    }

    override public var description: String {
        let keyList = allKeys().prefix(5).joined(separator: ", ")
        let suffix = allKeys().count > 5 ? "..." : ""
        return "<SCDictionary id=\(id) keys=[\(keyList)\(suffix)]>"
    }

    override public func unwrap() -> any Sendable {
        var result: [String: any Sendable] = [:]
        for (key, value) in entries {
            result[key] = value.unwrap()
        }
        return result
    }
}
