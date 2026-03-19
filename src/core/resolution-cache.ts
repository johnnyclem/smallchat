import type { ResolvedTool, ToolIMP, ToolSelector } from './types.js';

/**
 * ResolutionCache — the method cache for toolkit_dispatch.
 *
 * Fixed-size LRU cache mapping selector hashes to resolved tools.
 * Equivalent to objc_msgSend's per-class inline cache.
 */
export class ResolutionCache {
  private cache: Map<string, ResolvedTool> = new Map();
  private maxSize: number;
  private minConfidence: number;

  constructor(maxSize = 1024, minConfidence = 0.85) {
    this.maxSize = maxSize;
    this.minConfidence = minConfidence;
  }

  /**
   * The hot path. Needs to be fast.
   * Returns null on cache miss — fall through to dispatch table.
   */
  lookup(selector: ToolSelector): ResolvedTool | null {
    const key = this.hashSelector(selector);
    const cached = this.cache.get(key);
    if (!cached) return null;

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
    });
  }

  /**
   * Invalidate all entries.
   * Equivalent to objc_msgSend cache flush on category load.
   */
  flush(): void {
    this.cache.clear();
  }

  /** Selective invalidation when a specific provider changes */
  flushProvider(providerId: string): void {
    for (const [key, resolved] of this.cache) {
      if (resolved.imp.providerId === providerId) {
        this.cache.delete(key);
      }
    }
  }

  /** Invalidate entries for a specific selector */
  flushSelector(selector: ToolSelector): void {
    const key = this.hashSelector(selector);
    this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }

  /** Hash a selector for cache keying. Uses canonical name. */
  private hashSelector(selector: ToolSelector): string {
    return selector.canonical;
  }
}
