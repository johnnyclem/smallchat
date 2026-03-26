public protocol VectorIndex: Sendable {
    func insert(id: String, vector: [Float]) async throws
    func search(query: [Float], topK: Int, threshold: Float) async throws -> [SelectorMatch]
    func remove(id: String) async throws
    func size() async throws -> Int
}
