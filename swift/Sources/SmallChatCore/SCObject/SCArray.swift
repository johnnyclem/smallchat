public final class SCArray: SCObject, @unchecked Sendable {
    private static let registered: Bool = {
        SCObjectRegistry.shared.register("SCArray", superclass: "SCObject")
        return true
    }()

    private var items: [SCObject]

    override public var isa: String { "SCArray" }

    public init(items: [SCObject] = []) {
        self.items = items
        super.init()
        _ = Self.registered
    }

    public var count: Int { items.count }

    public func objectAtIndex(_ index: Int) -> SCObject? {
        items.indices.contains(index) ? items[index] : nil
    }

    public func addObject(_ obj: SCObject) {
        items.append(obj)
    }

    public func allObjects() -> [SCObject] {
        items
    }

    override public var description: String {
        "<SCArray id=\(id) count=\(count)>"
    }

    override public func unwrap() -> any Sendable {
        items.map { $0.unwrap() } as [any Sendable]
    }
}
