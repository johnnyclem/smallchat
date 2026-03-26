import Foundation

/// SelectorTable -- the interning table for semantic selectors.
///
/// Like Objective-C's `sel_registerName`, this ensures that semantically
/// equivalent intents resolve to the same cached `ToolSelector` value.
/// "Pointer equality" becomes "embedding similarity above threshold."
public actor SelectorTable {
    private var selectors: [String: ToolSelector] = [:]
    private let index: any VectorIndex
    private let embedder: any Embedder
    private let threshold: Float
    private let rateLimiter: SemanticRateLimiter?

    public init(
        index: any VectorIndex,
        embedder: any Embedder,
        threshold: Float = 0.95,
        rateLimiter: SemanticRateLimiter? = nil
    ) {
        self.index = index
        self.embedder = embedder
        self.threshold = threshold
        self.rateLimiter = rateLimiter
    }

    /// Intern a selector. If a semantically equivalent one exists
    /// (cosine similarity > threshold), return the existing one.
    public func intern(embedding: [Float], canonical: String) async throws -> ToolSelector {
        // Check for exact canonical match first (fast path)
        if let existing = selectors[canonical] { return existing }

        // Check for semantic match via vector index
        let existing = try await index.search(query: embedding, topK: 1, threshold: threshold)
        if let match = existing.first, let sel = selectors[match.id] {
            return sel
        }

        // New selector -- create and intern
        let parts = canonical.split(separator: ":").map(String.init).filter { !$0.isEmpty }
        let sel = ToolSelector(
            vector: embedding,
            canonical: canonical,
            parts: parts,
            arity: max(0, parts.count - 1)
        )

        selectors[canonical] = sel
        try await index.insert(id: canonical, vector: embedding)
        return sel
    }

    /// Resolve a natural language intent to an interned selector.
    ///
    /// Checks the semantic rate limiter before embedding. If the system
    /// is under vector flood, throws `VectorFloodError` without touching
    /// the embedder.
    public func resolve(_ intent: String) async throws -> ToolSelector {
        let canonical = canonicalize(intent)

        // Fast path: if we already have this selector, skip embedding + rate check
        if let existing = selectors[canonical] { return existing }

        // Pre-embedding flood gate
        if let limiter = rateLimiter {
            let allowed = await limiter.check(canonical)
            if !allowed { throw VectorFloodError(canonical: canonical) }
        }

        let embedding = try await embedder.embed(intent)

        // Post-embedding: record for similarity tracking
        if let limiter = rateLimiter {
            await limiter.record(canonical, embedding)
            _ = await limiter.checkSimilarity()
        }

        return try await intern(embedding: embedding, canonical: canonical)
    }

    /// Look up a selector by its canonical name.
    public func get(_ canonical: String) -> ToolSelector? {
        selectors[canonical]
    }

    /// Number of interned selectors.
    public var size: Int { selectors.count }

    /// All interned selectors.
    public func all() -> [ToolSelector] {
        Array(selectors.values)
    }
}
