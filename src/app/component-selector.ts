import type { Embedder, VectorIndex, SelectorMatch, ComponentSelector } from '../core/types.js';

/**
 * ComponentSelectorTable — SEL interning table for UI component dispatch.
 *
 * Mirrors SelectorTable in src/core/selector-table.ts, but operates over a
 * separate VectorIndex so component intents ("show a bar chart") and tool
 * intents ("find files") do not collide in the same embedding space.
 *
 * Like sel_registerName(), intern() ensures that semantically equivalent UI
 * intents ("display histogram", "show bar chart") resolve to the same cached
 * ComponentSelector object via cosine-similarity deduplication.
 */
export class ComponentSelectorTable {
  private selectors: Map<string, ComponentSelector> = new Map();
  private index: VectorIndex;
  private embedder: Embedder;
  private threshold: number;

  constructor(index: VectorIndex, embedder: Embedder, threshold = 0.95) {
    this.index = index;
    this.embedder = embedder;
    this.threshold = threshold;
  }

  /**
   * Intern a component selector from a pre-computed embedding.
   * Returns an existing selector if a semantically equivalent one exists.
   */
  async intern(embedding: Float32Array, canonical: string): Promise<ComponentSelector> {
    const exactMatch = this.selectors.get(canonical);
    if (exactMatch) return exactMatch;

    const existing = await this.index.search(embedding, 1, this.threshold);
    if (existing.length > 0) {
      const match = this.selectors.get(existing[0].id);
      if (match) return match;
    }

    const parts = canonical.split(':').filter(Boolean);
    const sel: ComponentSelector = {
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
   * Resolve a UI intent string to a ComponentSelector.
   * Embeds the intent and concatenates any capability tags before embedding
   * so that "show bar chart [chart interactive]" gets a richer vector.
   *
   * Returns the interned component selector the intent matches (exact
   * canonical, or nearest at or above the dedup threshold). An intent that
   * matches none gets a transient selector that is never added to the
   * table or its index: resolving intents must not grow the component
   * index, or later queries would land on a past intent instead of the
   * component (the core SelectorTable had the same bug).
   */
  async resolve(intent: string, capabilities: string[] = []): Promise<ComponentSelector> {
    const canonical = canonicalizeComponent(intent);

    const existing = this.selectors.get(canonical);
    if (existing) return existing;

    const embeddingText = capabilities.length > 0
      ? `${intent} [${capabilities.join(' ')}]`
      : intent;

    const embedding = await this.embedder.embed(embeddingText);
    const matches = await this.index.search(embedding, 1, this.threshold);
    if (matches.length > 0) {
      const match = this.selectors.get(matches[0].id);
      if (match) return match;
    }

    const parts = canonical.split(':').filter(Boolean);
    return { vector: embedding, canonical, parts, arity: Math.max(0, parts.length - 1) };
  }

  /** Look up a selector by canonical name */
  get(canonical: string): ComponentSelector | undefined {
    return this.selectors.get(canonical);
  }

  /** Find nearest selectors to a vector */
  nearest(vector: Float32Array, topK: number, threshold: number): SelectorMatch[] | Promise<SelectorMatch[]> {
    return this.index.search(vector, topK, threshold);
  }

  get size(): number {
    return this.selectors.size;
  }

  all(): ComponentSelector[] {
    return Array.from(this.selectors.values());
  }
}

/**
 * Canonicalize a UI intent into colon-separated component selector form.
 * "show me a bar chart of sales data" → "show:bar:chart:sales:data"
 */
export function canonicalizeComponent(intent: string): string {
  const stopwords = new Set([
    'a', 'an', 'the', 'my', 'your', 'me', 'us', 'of', 'in', 'on',
    'at', 'to', 'for', 'with', 'by', 'and', 'or', 'as', 'is', 'it',
  ]);

  return intent
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopwords.has(w))
    .join(':');
}
