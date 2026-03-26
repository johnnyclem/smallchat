public struct ToolMethod: Sendable {
    public let selector: ToolSelector
    public let imp: any ToolIMP

    public init(selector: ToolSelector, imp: any ToolIMP) {
        self.selector = selector
        self.imp = imp
    }
}
