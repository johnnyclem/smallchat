public final class SCSelector: SCObject {
    private static let registered: Bool = {
        SCObjectRegistry.shared.register("SCSelector", superclass: "SCObject")
        return true
    }()

    public let selector: ToolSelector

    override public var isa: String { "SCSelector" }

    public init(selector: ToolSelector) {
        self.selector = selector
        super.init()
        _ = Self.registered
    }

    override public var description: String {
        "<SCSelector id=\(id) canonical=\"\(selector.canonical)\">"
    }

    override public func unwrap() -> any Sendable {
        selector
    }
}
