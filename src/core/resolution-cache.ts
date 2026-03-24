import type {
  ResolvedTool,
  ToolIMP,
  ToolSelector,
  CacheVersionContext,
  InvalidationEvent,
  InvalidationHook,
} from './types.js';
import { SemanticRateLimiter } from './semantic-rate-limiter.js';
import type { SemanticRateLimiterOptions, FloodingMetrics } from './semantic-rate-limiter.js';

/**
 * ResolutionCache — the method cache for toolkit_dispatch.
 *
 * Fixed-size LRU cache mapping selector hashes to resolved tools.
 * Equivalent to objc_msgSend's per-class inline cache.
 *
 * Entries are tagged with provider version, model version, and schema
 * fingerprint at store-time. On lookup, stale entries (version/schema
 * mismatch) are evicted transparently — the caller sees a cache miss
 * and re-resolves through the dispatch table.
 *
 * Register invalidateOn hooks for hot-reload coordination: downstream
 * consumers get notified on any invalidation event without polling.
 */
export class ResolutionCache {
  private cache: Map<string, ResolvedTool> = new Map();
  private maxSize: number;
  private minConfidence: number;

  /** Current version context — entries are checked against this on lookup */
  private versionContext: CacheVersionContext;

  /** Registered invalidation hooks — fire on any cache mutation */
  private hooks: InvalidationHook[] = [];

  /** Semantic rate limiter — prevents vector flooding DoS */
  readonly rateLimiter: SemanticRateLimiter;

  constructor(
    maxSize = 1024,
    minConfidence = 0.85,
    versionContext?: CacheVersionContext,
    rateLimiterOptions?: SemanticRateLimiterOptions,
  ) {
    this.maxSize = maxSize;
    this.minConfidence = minConfidence;
    this.versionContext = versionContext ?? {
      providerVersions: new Map(),
      modelVersion: '',
      schemaFingerprints: new Map(),
    };
    this.rateLimiter = new SemanticRateLimiter(rateLimiterOptions);
  }

  /**
   * The hot path. Needs to be fast.
   * Returns null on cache miss — fall through to dispatch table.
   *
   * Transparently evicts stale entries (version or schema mismatch)
   * so the caller simply sees a miss and re-resolves.
   */
  lookup(selector: ToolSelector): ResolvedTool | null {
    const key = this.hashSelector(selector);
    const cached = this.cache.get(key);
    if (!cached) return null;

    // Check staleness: provider version
    if (cached.providerVersion) {
      const currentVersion = this.versionContext.providerVersions.get(cached.imp.providerId);
      if (currentVersion && currentVersion !== cached.providerVersion) {
        this.cache.delete(key);
        this.emit({ type: 'stale', reason: 'provider-version', key });
        return null;
      }
    }

    // Check staleness: model version
    if (cached.modelVersion && this.versionContext.modelVersion
        && cached.modelVersion !== this.versionContext.modelVersion) {
      this.cache.delete(key);
      this.emit({ type: 'stale', reason: 'model-version', key });
      return null;
    }

    // Check staleness: schema fingerprint
    if (cached.schemaFingerprint) {
      const currentFingerprint = this.versionContext.schemaFingerprints.get(cached.imp.providerId);
      if (currentFingerprint && currentFingerprint !== cached.schemaFingerprint) {
        this.cache.delete(key);
        this.emit({ type: 'stale', reason: 'schema-change', key });
        return null;
      }
    }

    // Move to end for LRU ordering
    this.cache.delete(key);
    this.cache.set(key, cached);
    cached.hitCount++;
    return cached;
  }

  /**
   * Cache a resolution after dispatch table lookup.
   * Only caches high-confidence resolutions — ambiguous results
   * should not shortcut next time.
   *
   * Tags the entry with current provider version, model version,
   * and schema fingerprint so future lookups can detect staleness.
   */
  store(selector: ToolSelector, imp: ToolIMP, confidence: number): void {
    if (confidence < this.minConfidence) return;

    const key = this.hashSelector(selector);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, {
      selector,
      imp,
      confidence,
      resolvedAt: Date.now(),
      hitCount: 1,
      providerVersion: this.versionContext.providerVersions.get(imp.providerId),
      modelVersion: this.versionContext.modelVersion || undefined,
      schemaFingerprint: this.versionContext.schemaFingerprints.get(imp.providerId),
    });
  }

  /**
   * Invalidate all entries.
   * Equivalent to objc_msgSend cache flush on category load.
   */
  flush(): void {
    this.cache.clear();
    this.emit({ type: 'flush' });
  }

  /** Selective invalidation when a specific provider changes */
  flushProvider(providerId: string): void {
    for (const [key, resolved] of this.cache) {
      if (resolved.imp.providerId === providerId) {
        this.cache.delete(key);
      }
    }
    this.emit({ type: 'provider', providerId });
  }

  /** Invalidate entries for a specific selector */
  flushSelector(selector: ToolSelector): void {
    const key = this.hashSelector(selector);
    this.cache.delete(key);
    this.emit({ type: 'selector', selector });
  }

  // ---------------------------------------------------------------------------
  // Version context mutations
  // ---------------------------------------------------------------------------

  /** Update a provider's version — stale entries auto-expire on next lookup */
  setProviderVersion(providerId: string, version: string): void {
    this.versionContext.providerVersions.set(providerId, version);
  }

  /** Update the model/embedder version — all cached entries become stale */
  setModelVersion(version: string): void {
    this.versionContext.modelVersion = version;
  }

  /** Update a provider's schema fingerprint — stale entries auto-expire on next lookup */
  setSchemaFingerprint(providerId: string, fingerprint: string): void {
    this.versionContext.schemaFingerprints.set(providerId, fingerprint);
  }

  /** Get the current version context (read-only snapshot) */
  getVersionContext(): Readonly<CacheVersionContext> {
    return this.versionContext;
  }

  // ---------------------------------------------------------------------------
  // Invalidation hooks — hot-reload coordination
  // ---------------------------------------------------------------------------

  /**
   * Register a hook that fires on any invalidation event.
   * Returns an unsubscribe function.
   *
   * Use for hot-reload: when a provider hot-reloads its schema,
   * call setSchemaFingerprint() and stale entries auto-expire.
   * The hook lets downstream consumers (UI, LLM context, etc.)
   * react immediately rather than discovering staleness lazily.
   */
  invalidateOn(hook: InvalidationHook): () => void {
    this.hooks.push(hook);
    return () => {
      const idx = this.hooks.indexOf(hook);
      if (idx >= 0) this.hooks.splice(idx, 1);
    };
  }

  // ---------------------------------------------------------------------------
  // Semantic rate limiting — vector flooding prevention
  // ---------------------------------------------------------------------------

  /**
   * Pre-embedding check: should this intent be allowed through to the embedder?
   *
   * Call before invoking the embedder. Returns true if the intent is safe to
   * embed; false if the system is under vector flood and the embedder should
   * be throttled. When false, callers should reject the request immediately.
   */
  checkFloodGate(canonical: string): boolean {
    return this.rateLimiter.check(canonical);
  }

  /**
   * Post-embedding record: log a successfully-embedded intent for flood analysis.
   *
   * Call after the embedder returns a vector and before (or after) caching.
   * The vector is added to the sliding window so future `checkFloodGate`
   * calls can detect flooding patterns via cross-similarity analysis.
   *
   * Returns true if the traffic pattern still looks healthy (similarity above
   * floor); false if similarity has dropped below the floor — callers may
   * choose to start rejecting subsequent intents pre-emptively.
   */
  recordIntent(canonical: string, vector: Float32Array): boolean {
    this.rateLimiter.record(canonical, vector);
    return this.rateLimiter.checkSimilarity();
  }

  /** Get current flooding metrics for monitoring/debugging */
  getFloodingMetrics(): FloodingMetrics {
    return this.rateLimiter.getMetrics();
  }

  get size(): number {
    return this.cache.size;
  }

  /** Hash a selector for cache keying. Uses canonical name. */
  private hashSelector(selector: ToolSelector): string {
    return selector.canonical;
  }

  /** Emit an invalidation event to all registered hooks */
  private emit(event: InvalidationEvent): void {
    for (const hook of this.hooks) {
      hook(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Schema fingerprinting utility
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic fingerprint for a provider's tool schemas.
 * Uses a simple DJB2 hash over the sorted JSON representation —
 * fast enough for the hot path, collision-resistant enough for versioning.
 */
export function computeSchemaFingerprint(schemas: Array<{ name: string; inputSchema: unknown }>): string {
  // Sort by name for determinism
  const sorted = [...schemas].sort((a, b) => a.name.localeCompare(b.name));
  const content = JSON.stringify(sorted);

  // DJB2 hash — fast, simple, good distribution
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }

  // Return as hex string
  return (hash >>> 0).toString(16).padStart(8, '0');
}
