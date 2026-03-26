public struct ToolCandidate: Sendable {
    public let imp: any ToolIMP
    public let confidence: Double
    public let selector: ToolSelector

    public init(imp: any ToolIMP, confidence: Double, selector: ToolSelector) {
        self.imp = imp
        self.confidence = confidence
        self.selector = selector
    }
}
