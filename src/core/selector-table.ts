import type { Embedder, ToolSelector, VectorIndex, SelectorMatch } from './types.js';
import { quantizeScore, SCORE_QUANTUM } from './confidence.js';

/**
 * VectorFloodError — the semantic rate limiter refused an intent.
 *
 * @deprecated smallchat no longer throws it: a throttled intent resolves
 * to outcome 'throttled' with a retry-after (see SemanticRateLimiter).
 * Kept so existing `instanceof` checks and callers that drive a
 * SemanticRateLimiter themselves still compile.
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

/**
 * SelectorTable — the table of compiled tool (and alias) selectors.
 *
 * Like Objective-C's sel_registerName, it maps a canonical selector name
 * to one ToolSelector object and keeps the vector index that tool
 * resolution searches. It holds tool selectors only: a runtime intent is
 * embedded on its own (resolve/probe) and is never added to the table or
 * the vector index, so what an intent resolves to does not depend on which
 * other intents the process has seen.
 */
export class SelectorTable {
  private selectors: Map<string, ToolSelector> = new Map();
  private index: VectorIndex;
  private embedder: Embedder;
  private threshold: number;

  constructor(index: VectorIndex, embedder: Embedder, threshold = 0.95) {
    this.index = index;
    this.embedder = embedder;
    this.threshold = threshold;
  }

  /**
   * Intern a tool selector. If a tool selector with this canonical, or one
   * semantically equivalent to it (cosine similarity >= threshold), is
   * already in the table, return it; otherwise add a new one. Only tool
   * selectors are ever matched — the table holds nothing else. Use
   * `register()` to keep two similar tools apart.
   */
  async intern(embedding: Float32Array, canonical: string): Promise<ToolSelector> {
    // Check for exact canonical match first (fast path)
    const exactMatch = this.selectors.get(canonical);
    if (exactMatch) return exactMatch;

    // Check for semantic match via vector index
    const existing = await this.index.search(embedding, 1, this.threshold);
    if (existing.length > 0) {
      const match = this.selectors.get(existing[0].id);
      if (match) return match;
    }

    return this.register(embedding, canonical);
  }

  /**
   * Register a compiled tool or alias selector under its exact canonical
   * name. Unlike intern(), this never folds the selector into a
   * semantically similar existing one — two distinct tools always get two
   * distinct selectors. Registering an existing canonical again returns the
   * selector already in the table.
   */
  register(embedding: Float32Array, canonical: string): ToolSelector {
    const existing = this.selectors.get(canonical);
    if (existing) return existing;

    const parts = canonical.split(':').filter(Boolean);
    const sel: ToolSelector = {
      vector: embedding,
      canonical,
      parts,
      arity: Math.max(0, parts.length - 1),
      provenance: 'tool',
    };
    this.selectors.set(canonical, sel);
    this.index.insert(canonical, embedding);
    return sel;
  }

  /**
   * Embed a natural language intent. The returned selector carries this
   * exact text's own embedding, its display canonical (canonicalize) and
   * its identity key (intentKey); the table and the vector index are left
   * unchanged. Equivalent to sel_getName() for an intent.
   */
  async resolve(intent: string): Promise<ToolSelector> {
    return intentSelector(intent, await this.embedder.embed(intent));
  }

  /**
   * Same as resolve(). Kept as the name side-effect-free resolution used
   * before 1.0, when resolve() interned the intent.
   */
  probe(intent: string): Promise<ToolSelector> {
    return this.resolve(intent);
  }

  /** Look up a selector by its canonical name */
  get(canonical: string): ToolSelector | undefined {
    return this.selectors.get(canonical);
  }

  /**
   * The raw nearest-neighbour search over the vector index, including any
   * ids the index holds that are not registered selectors (e.g. rows a
   * shared SQLite index carries from elsewhere). Prefer `searchTools()`.
   */
  nearest(vector: Float32Array, topK: number, threshold: number): SelectorMatch[] | Promise<SelectorMatch[]> {
    return this.index.search(vector, topK, threshold);
  }

  /**
   * Find the nearest registered tool selectors to a vector, best first.
   *
   * Similarities are compared after quantization (quantizeScore): a
   * selector is included when its quantized similarity is >= threshold,
   * and selectors with equal quantized similarity are ordered by id, so the
   * result — including which selectors make the topK cut — is the same
   * whatever order they were registered in and whichever vector backend
   * computed the distances. Index rows that are not registered selectors
   * are skipped; the search widens until topK registered selectors are
   * found (and every tie at the cut is seen) or the index is exhausted.
   */
  async searchTools(vector: Float32Array, topK: number, threshold: number): Promise<SelectorMatch[]> {
    if (topK <= 0) return [];
    const similarity = (m: SelectorMatch): number => quantizeScore(1 - m.distance);
    // A raw similarity that rounds up to the threshold still counts.
    const rawThreshold = threshold - SCORE_QUANTUM / 2;
    let fetchK = topK + 1;
    for (;;) {
      const raw = await this.index.search(vector, fetchK, rawThreshold);
      const exhausted = raw.length < fetchK;
      const results = raw
        .filter(m => this.selectors.has(m.id) && similarity(m) >= threshold)
        .sort((a, b) => similarity(b) - similarity(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const lastFetched = raw.length > 0 ? similarity(raw[raw.length - 1]) : -1;
      const cut = results.length >= topK ? similarity(results[topK - 1]) : null;
      // Done when the index is exhausted, or we have topK and everything
      // fetched beyond them scores strictly lower than the cut.
      if (exhausted || (cut !== null && lastFetched < cut)) return results.slice(0, topK);
      fetchK *= 2;
    }
  }

  /** Number of registered selectors */
  get size(): number {
    return this.selectors.size;
  }

  /** All registered tool selectors */
  all(): ToolSelector[] {
    return Array.from(this.selectors.values());
  }
}

/**
 * The selector for a runtime intent: its own embedding, a display
 * canonical, and its identity key. Never interned.
 */
export function intentSelector(intent: string, vector: Float32Array): ToolSelector {
  const canonical = canonicalize(intent);
  const parts = canonical.split(':').filter(Boolean);
  return {
    vector,
    canonical,
    parts,
    arity: Math.max(0, parts.length - 1),
    provenance: 'intent',
    key: intentKey(intent),
  };
}

/**
 * The identity of an intent: its full text in Unicode NFC, trimmed, with
 * runs of whitespace collapsed to one space, lower-cased. Nothing else is
 * removed — negations, stopwords, punctuation and non-Latin scripts all
 * keep two intents apart. The resolution cache, the semantic map and
 * explicit feedback key on it. (canonicalize() is for display only.)
 */
export function intentKey(intent: string): string {
  return intent.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase().normalize('NFC');
}

/**
 * Convert a natural language intent into a canonical selector form, for
 * display: "find my recent documents" → "find:recent:documents".
 *
 * It drops stopwords (including "not") and punctuation, so two different
 * intents can share a canonical form. Never use it as an identity key —
 * use intentKey().
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
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, '')
    .split(/\s+/u)
    .filter(w => w.length > 0 && !stopwords.has(w));

  return words.join(':') || 'unknown';
}
