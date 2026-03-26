import SmallChatCore

/// In-memory vector index using brute-force cosine similarity.
/// Sufficient for small-to-medium registries (< 10K tools).
public actor MemoryVectorIndex: VectorIndex {
    private var vectors: [String: [Float]] = [:]

    public init() {}

    public func insert(id: String, vector: [Float]) {
        vectors[id] = vector
    }

    public func search(query: [Float], topK: Int, threshold: Float) -> [SelectorMatch] {
        var results: [SelectorMatch] = []

        for (id, vector) in vectors {
            let similarity = cosineSimilarity(query, vector)
            if similarity >= threshold {
                results.append(SelectorMatch(id: id, distance: 1 - similarity))
            }
        }

        results.sort { $0.distance < $1.distance }
        return Array(results.prefix(topK))
    }

    public func remove(id: String) {
        vectors.removeValue(forKey: id)
    }

    public func size() -> Int {
        vectors.count
    }
}
