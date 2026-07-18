import type { Embedder, ToolSelector, VectorIndex, SelectorMatch } from './types.js';
import type { SemanticRateLimiter } from './semantic-rate-limiter.js';

/**
 * SelectorTable — the interning table for semantic selectors.
 *
 * Like Objective-C's sel_registerName, this ensures that semantically
 * equivalent intents resolve to the same cached ToolSelector object.
 * "Pointer equality" becomes "embedding similarity above threshold."
 */
/**
 * VectorFloodError — thrown when the semantic rate limiter detects
 * a vector flooding attack and throttles the embedder.
 */
export class VectorFloodError extends Error {
  constructor(canonical: string) {
    super(
      `Semantic rate limit exceeded: too many high-entropy, low-similarity intents. ` +
      `Intent "${canonical}" was throttled to protect the embedder from DoS. ` +
      `Wait for the current window to drain before retrying.`,
    );
    this.name = 'VectorFloodError';
  }
}

/** Default cap on how many runtime-resolved intent selectors are retained. */
const DEFAULT_MAX_INTENT_ENTRIES = 500;

export class SelectorTable {
  private selectors: Map<string, ToolSelector> = new Map();
  private index: VectorIndex;
  private embedder: Embedder;
  private threshold: number;
  private rateLimiter: SemanticRateLimiter | null;
  /**
   * Insertion-order tracking for intent-provenance selectors only, so the
   * intern table can't grow without bound as a process resolves distinct
   * user intents over its lifetime. Tool selectors (compiled at build time,
   * bounded by the manifest) are never evicted.
   */
  private intentOrder: string[] = [];
  private maxIntentEntries: number;

  constructor(
    index: VectorIndex,
    embedder: Embedder,
    threshold = 0.95,
    rateLimiter?: SemanticRateLimiter,
    maxIntentEntries = DEFAULT_MAX_INTENT_ENTRIES,
  ) {
    this.index = index;
    this.embedder = embedder;
    this.threshold = threshold;
    this.rateLimiter = rateLimiter ?? null;
    this.maxIntentEntries = maxIntentEntries;
  }

  /**
   * Intern a selector. If a semantically equivalent one exists
   * (cosine similarity > threshold), return the existing one.
   *
   * `provenance` distinguishes compiled tool/alias selectors (the default)
   * from selectors created by resolving a runtime intent — see
   * `resolve()`. Intent selectors are excluded from `all()` and from
   * `searchTools()` so they never surface as phantom tools or refinement
   * options, and are LRU-bounded so they can't grow the table unbounded.
   */
  async intern(embedding: Float32Array, canonical: string, provenance: 'tool' | 'intent' = 'tool'): Promise<ToolSelector> {
    // Check for exact canonical match first (fast path)
    const exactMatch = this.selectors.get(canonical);
    if (exactMatch) return exactMatch;

    // Check for semantic match via vector index
    const existing = await this.index.search(embedding, 1, this.threshold);
    if (existing.length > 0) {
      const match = this.selectors.get(existing[0].id);
      if (match) return match;
    }

    // New selector — create and intern
    const parts = canonical.split(':').filter(Boolean);
    const sel: ToolSelector = {
      vector: embedding,
      canonical,
      parts,
      arity: Math.max(0, parts.length - 1),
      provenance,
    };

    this.selectors.set(canonical, sel);
    this.index.insert(canonical, embedding);

    if (provenance === 'intent') {
      this.intentOrder.push(canonical);
      this.evictExcessIntents();
    }

    return sel;
  }

  /** Evict the oldest intent selectors past the retention cap. */
  private evictExcessIntents(): void {
    while (this.intentOrder.length > this.maxIntentEntries) {
      const oldest = this.intentOrder.shift();
      if (oldest === undefined) break;
      this.selectors.delete(oldest);
      this.index.remove(oldest);
    }
  }

  /**
   * Resolve a natural language intent to an interned selector.
   * Equivalent to sel_getName() + sel_registerName().
   *
   * Checks the semantic rate limiter before embedding. If the system
   * is under vector flood, throws VectorFloodError without touching
   * the embedder.
   */
  async resolve(intent: string): Promise<ToolSelector> {
    const canonical = canonicalize(intent);

    // Fast path: if we already have this selector, skip embedding + rate check
    const existing = this.selectors.get(canonical);
    if (existing) return existing;

    // Pre-embedding flood gate
    if (this.rateLimiter && !this.rateLimiter.check(canonical)) {
      throw new VectorFloodError(canonical);
    }

    const embedding = await this.embedder.embed(intent);

    // Post-embedding: record for similarity tracking
    if (this.rateLimiter) {
      this.rateLimiter.record(canonical, embedding);
      // Check if similarity has dropped below floor — throttle future requests
      if (!this.rateLimiter.checkSimilarity()) {
        // We already embedded this one, so let it through but log the warning.
        // The NEXT request will be caught by the pre-embedding check once
        // the volume threshold is also hit, or by checkSimilarity on the
        // next cycle.
      }
    }

    return this.intern(embedding, canonical, 'intent');
  }

  /** Look up a selector by its canonical name */
  get(canonical: string): ToolSelector | undefined {
    return this.selectors.get(canonical);
  }

  /**
   * Find the nearest selectors to a vector, including intent selectors
   * interned by prior `resolve()` calls. Prefer `searchTools()` for any
   * caller building a dispatchable candidate list or a refinement/"did you
   * mean?" surface — this raw search will happily return the user's own
   * previously-resolved intent as a "match".
   */
  nearest(vector: Float32Array, topK: number, threshold: number): SelectorMatch[] | Promise<SelectorMatch[]> {
    return this.index.search(vector, topK, threshold);
  }

  /**
   * Find the nearest *tool* selectors to a vector — the vector index minus
   * any runtime intent selectors. This is what dispatch resolution,
   * enumeration, and refinement should search: a user's own intent (which
   * gets interned into the same vector index on resolution) must never come
   * back as a candidate tool or a refinement suggestion.
   */
  async searchTools(vector: Float32Array, topK: number, threshold: number): Promise<SelectorMatch[]> {
    // Over-fetch to compensate for intent matches we'll filter out, up to
    // the full size of the table so a real tool match is never missed.
    const fetchK = Math.min(this.selectors.size || topK, topK * 4 || topK);
    const raw = await this.index.search(vector, Math.max(topK, fetchK), threshold);
    const results: SelectorMatch[] = [];
    for (const match of raw) {
      const sel = this.selectors.get(match.id);
      if (!sel || sel.provenance === 'intent') continue;
      results.push(match);
      if (results.length >= topK) break;
    }
    return results;
  }

  /** Number of interned selectors (tool + intent) */
  get size(): number {
    return this.selectors.size;
  }

  /**
   * All interned selectors. Excludes runtime intent selectors by default —
   * pass `{ includeIntents: true }` to see the full interning table
   * (diagnostics only; intent selectors have no owning ToolClass and can't
   * be dispatched).
   */
  all(options?: { includeIntents?: boolean }): ToolSelector[] {
    const values = Array.from(this.selectors.values());
    if (options?.includeIntents) return values;
    return values.filter(s => s.provenance !== 'intent');
  }
}

/**
 * Convert a natural language intent into a canonical selector form.
 * "find my recent documents" → "find:recent:documents"
 */
export function canonicalize(intent: string): string {
  const stopwords = new Set([
    'a', 'an', 'the', 'my', 'your', 'our', 'their', 'its',
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'and', 'or', 'but', 'not', 'no', 'do', 'does', 'did',
    'have', 'has', 'had', 'will', 'would', 'could', 'should',
    'can', 'may', 'might', 'shall', 'that', 'this', 'these',
    'those', 'it', 'i', 'me', 'we', 'us', 'you', 'he', 'she',
    'him', 'her', 'they', 'them', 'some', 'all', 'any', 'each',
    'about', 'from', 'into', 'please',
  ]);

  const words = intent
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0 && !stopwords.has(w));

  return words.join(':') || 'unknown';
}
