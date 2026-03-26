public struct SelectorMatch: Sendable, Equatable {
    public let id: String
    public let distance: Float

    public init(id: String, distance: Float) {
        self.id = id
        self.distance = distance
    }
}
