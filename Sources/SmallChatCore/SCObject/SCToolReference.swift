public final class SCToolReference: SCObject {
    private static let registered: Bool = {
        SCObjectRegistry.shared.register("SCToolReference", superclass: "SCObject")
        return true
    }()

    public let imp: any ToolIMP

    override public var isa: String { "SCToolReference" }

    public init(imp: any ToolIMP) {
        self.imp = imp
        super.init()
        _ = Self.registered
    }

    override public var description: String {
        "<SCToolReference id=\(id) tool=\"\(imp.toolName)\" provider=\"\(imp.providerId)\">"
    }

    override public func unwrap() -> any Sendable {
        imp
    }
}
