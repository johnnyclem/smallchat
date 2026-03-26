public struct InferenceDelta: Sendable {
    public let text: String
    public let finishReason: FinishReason?
    public let index: Int?
    public let providerMeta: [String: any Sendable]?

    public init(
        text: String,
        finishReason: FinishReason? = nil,
        index: Int? = nil,
        providerMeta: [String: any Sendable]? = nil
    ) {
        self.text = text
        self.finishReason = finishReason
        self.index = index
        self.providerMeta = providerMeta
    }

    public enum FinishReason: String, Sendable, Codable {
        case stop
        case length
        case toolUse = "tool_use"
        case endTurn = "end_turn"
    }
}
