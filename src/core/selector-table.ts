import type { Embedder, ToolSelector, VectorIndex, SelectorMatch } from './types.js';

/**
 * SelectorTable — the interning table for semantic selectors.
 *
 * Like Objective-C's sel_registerName, this ensures that semantically
 * equivalent intents resolve to the same cached ToolSelector object.
 * "Pointer equality" becomes "embedding similarity above threshold."
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
   * Intern a selector. If a semantically equivalent one exists
   * (cosine similarity > threshold), return the existing one.
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

    // New selector — create and intern
    const parts = canonical.split(':').filter(Boolean);
    const sel: ToolSelector = {
      vector: embedding,
      canonical,
      parts,
      arity: Math.max(0, parts.length - 1),
    };

    this.selectors.set(canonical, sel);
    this.index.insert(canonical, embedding);
    return sel;
  }

  /**
   * Resolve a natural language intent to an interned selector.
   * Equivalent to sel_getName() + sel_registerName().
   */
  async resolve(intent: string): Promise<ToolSelector> {
    const embedding = await this.embedder.embed(intent);
    const canonical = canonicalize(intent);
    return this.intern(embedding, canonical);
  }

  /** Look up a selector by its canonical name */
  get(canonical: string): ToolSelector | undefined {
    return this.selectors.get(canonical);
  }

  /** Find the nearest selectors to a vector */
  nearest(vector: Float32Array, topK: number, threshold: number): SelectorMatch[] | Promise<SelectorMatch[]> {
    return this.index.search(vector, topK, threshold);
  }

  /** Number of interned selectors */
  get size(): number {
    return this.selectors.size;
  }

  /** All interned selectors */
  all(): ToolSelector[] {
    return Array.from(this.selectors.values());
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
