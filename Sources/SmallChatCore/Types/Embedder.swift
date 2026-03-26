public protocol Embedder: Sendable {
    var dimensions: Int { get }
    func embed(_ text: String) async throws -> [Float]
    func embedBatch(_ texts: [String]) async throws -> [[Float]]
}

extension Embedder {
    public func embedBatch(_ texts: [String]) async throws -> [[Float]] {
        try await withThrowingTaskGroup(of: (Int, [Float]).self) { group in
            for (i, text) in texts.enumerated() {
                group.addTask { (i, try await self.embed(text)) }
            }
            var results = Array(repeating: [Float](), count: texts.count)
            for try await (i, vec) in group {
                results[i] = vec
            }
            return results
        }
    }
}
