import Foundation
import OrderedCollections

/// ResolutionCache -- the method cache for toolkit_dispatch.
///
/// Fixed-size LRU cache mapping selector hashes to resolved tools.
/// Equivalent to `objc_msgSend`'s per-class inline cache.
///
/// Entries are tagged with provider version, model version, and schema
/// fingerprint at store-time. On lookup, stale entries (version/schema
/// mismatch) are evicted transparently -- the caller sees a cache miss
/// and re-resolves through the dispatch table.
///
/// Register `invalidateOn` hooks for hot-reload coordination: downstream
/// consumers get notified on any invalidation event without polling.
public actor ResolutionCache {
    private var cache: OrderedDictionary<String, ResolvedTool>
    private let maxSize: Int
    private let minConfidence: Double
    private var versionContext: CacheVersionContext
    private var hooks: [InvalidationHook] = []

    /// Semantic rate limiter -- prevents vector flooding DoS.
    public let rateLimiter: SemanticRateLimiter

    public init(
        maxSize: Int = 1024,
        minConfidence: Double = 0.85,
        versionContext: CacheVersionContext? = nil,
        rateLimiterOptions: SemanticRateLimiterOptions? = nil
    ) {
        self.cache = OrderedDictionary()
        self.maxSize = maxSize
        self.minConfidence = minConfidence
        self.versionContext = versionContext ?? CacheVersionContext(
            providerVersions: [:],
            modelVersion: "",
            schemaFingerprints: [:]
        )
        self.rateLimiter = SemanticRateLimiter(options: rateLimiterOptions ?? SemanticRateLimiterOptions())
    }

    // MARK: - Lookup & Store

    /// The hot path. Returns nil on cache miss -- fall through to dispatch table.
    ///
    /// Transparently evicts stale entries (version or schema mismatch)
    /// so the caller simply sees a miss and re-resolves.
    public func lookup(_ selector: ToolSelector) -> ResolvedTool? {
        let key = selector.canonical
        guard var cached = cache[key] else { return nil }

        // Check staleness: provider version
        if let pv = cached.providerVersion {
            if let current = versionContext.providerVersions[cached.imp.providerId], current != pv {
                cache.removeValue(forKey: key)
                emit(.stale(reason: .providerVersion, key: key))
                return nil
            }
        }

        // Check staleness: model version
        if let mv = cached.modelVersion,
           !versionContext.modelVersion.isEmpty,
           mv != versionContext.modelVersion {
            cache.removeValue(forKey: key)
            emit(.stale(reason: .modelVersion, key: key))
            return nil
        }

        // Check staleness: schema fingerprint
        if let sf = cached.schemaFingerprint {
            if let current = versionContext.schemaFingerprints[cached.imp.providerId], current != sf {
                cache.removeValue(forKey: key)
                emit(.stale(reason: .schemaChange, key: key))
                return nil
            }
        }

        // Move to end for LRU ordering
        cache.removeValue(forKey: key)
        cached.hitCount += 1
        cache[key] = cached
        return cached
    }

    /// Cache a resolution after dispatch table lookup.
    /// Only caches high-confidence resolutions -- ambiguous results
    /// should not shortcut next time.
    ///
    /// Tags the entry with current provider version, model version,
    /// and schema fingerprint so future lookups can detect staleness.
    public func store(_ selector: ToolSelector, imp: any ToolIMP, confidence: Double) {
        guard confidence >= minConfidence else { return }

        let key = selector.canonical

        // Evict oldest if at capacity
        if cache.count >= maxSize && cache[key] == nil {
            cache.removeFirst()
        }

        cache[key] = ResolvedTool(
            selector: selector,
            imp: imp,
            confidence: confidence,
            resolvedAt: Date(),
            hitCount: 1,
            providerVersion: versionContext.providerVersions[imp.providerId],
            modelVersion: versionContext.modelVersion.isEmpty ? nil : versionContext.modelVersion,
            schemaFingerprint: versionContext.schemaFingerprints[imp.providerId]
        )
    }

    // MARK: - Invalidation

    /// Invalidate all entries.
    public func flush() {
        cache.removeAll()
        emit(.flush)
    }

    /// Selective invalidation when a specific provider changes.
    public func flushProvider(_ providerId: String) {
        cache = cache.filter { $0.value.imp.providerId != providerId }
        emit(.provider(providerId: providerId))
    }

    /// Invalidate entries for a specific selector.
    public func flushSelector(_ selector: ToolSelector) {
        cache.removeValue(forKey: selector.canonical)
        emit(.selector(selector))
    }

    // MARK: - Version Context

    /// Update a provider's version -- stale entries auto-expire on next lookup.
    public func setProviderVersion(_ providerId: String, _ version: String) {
        versionContext.providerVersions[providerId] = version
    }

    /// Update the model/embedder version -- all cached entries become stale.
    public func setModelVersion(_ version: String) {
        versionContext.modelVersion = version
    }

    /// Update a provider's schema fingerprint -- stale entries auto-expire on next lookup.
    public func setSchemaFingerprint(_ providerId: String, _ fingerprint: String) {
        versionContext.schemaFingerprints[providerId] = fingerprint
    }

    /// Get the current version context (snapshot).
    public func getVersionContext() -> CacheVersionContext {
        versionContext
    }

    // MARK: - Invalidation Hooks

    /// Register a hook that fires on any invalidation event.
    /// Returns an ID that can be used for bookkeeping (hooks are append-only).
    @discardableResult
    public func invalidateOn(_ hook: @escaping InvalidationHook) -> Int {
        hooks.append(hook)
        return hooks.count - 1
    }

    // MARK: - Accessors

    /// Number of cached entries.
    public var size: Int { cache.count }

    // MARK: - Private

    private func emit(_ event: InvalidationEvent) {
        for hook in hooks { hook(event) }
    }
}

// MARK: - Schema Fingerprinting

/// Compute a deterministic fingerprint for a provider's tool schemas.
/// Uses DJB2 hash over sorted JSON representation -- fast enough for the
/// hot path, collision-resistant enough for versioning.
public func computeSchemaFingerprint(_ schemas: [(name: String, inputSchema: JSONSchemaType)]) -> String {
    let sorted = schemas.sorted { $0.name < $1.name }

    // Build a deterministic string representation
    var content = "["
    for (i, schema) in sorted.enumerated() {
        if i > 0 { content += "," }
        content += "{\"name\":\"\(schema.name)\",\"type\":\"\(schema.inputSchema.type)\"}"
    }
    content += "]"

    // DJB2 hash
    var hash: UInt32 = 5381
    for byte in content.utf8 {
        hash = ((hash &<< 5) &+ hash) &+ UInt32(byte)
    }
    return String(format: "%08x", hash)
}
