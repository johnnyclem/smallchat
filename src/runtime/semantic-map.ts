/**
 * Semantic Map — Pillar 4b of smallchat: deferred resolution, reinforced.
 *
 * The Refinement Protocol (Pillar 4) turns an unresolvable dispatch into a
 * dialogue: rather than *guessing* when confidence is NONE, smallchat defers
 * to the user — "I couldn't find an exact match. Did you mean one of these?"
 *
 * Deferring is the right call, but doing it *every* time is a tax. The Semantic
 * Map closes the loop. When the user picks one of the deferred options, that
 * choice is a high-quality training signal: this natural-language intent maps
 * to *that* selector. We record the intent's embedding alongside the chosen
 * selector so that:
 *
 *   1. The exact same question later resolves instantly (exact fast-path).
 *   2. A *similar* future question gets a confidence boost toward the selector
 *      the user taught us — often enough to lift a near-miss out of the "ask
 *      again" zone and dispatch it directly.
 *
 * The design mirrors the DispatchObserver's negative examples (Pillar 5), but
 * for *positive*, user-affirmed resolutions. Where the observer records what
 * NOT to dispatch from explicit feedback, the Semantic Map learns what TO
 * dispatch from explicit choices. Both are in-memory by default; the map is
 * serializable so a host application can persist it across sessions.
 *
 * "This exact question" means the same intentKey(): the full intent text up
 * to case, Unicode NFC form and whitespace. A negated or reworded intent is a
 * different question and can only draw a (bounded) similar-intent boost.
 */

import { cosineSimilarity } from '../core/vector-math.js';
import { quantizeScore } from '../core/confidence.js';
import { intentKey } from '../core/selector-table.js';

// ---------------------------------------------------------------------------
// Learned preference — one remembered intent → selector mapping
// ---------------------------------------------------------------------------

export interface LearnedPreference {
  /**
   * intentKey() of the intent the user disambiguated: its normalized full
   * text (negations and non-Latin scripts preserved).
   */
  intentKey: string;
  /**
   * Whether this preference can answer an exact lookup. False for entries
   * imported from a version 1 map, which were keyed by the lossy
   * canonicalize() form ("do not delete the logs" and "delete the logs"
   * shared one): they still boost similar intents, by vector.
   */
  exact: boolean;
  /** Embedding of the original intent — powers similar-intent matching */
  vector: Float32Array;
  /** Canonical selector id the user chose (the vector-index / dispatch id) */
  selectorId: string;
  /**
   * Canonical tool id the user chose through that selector, when known. A
   * selector can dispatch to several tools (overload variants, or several
   * classes declaring it); this is the one the preference stands for.
   * Absent on preferences recorded without it (they stand for the
   * selector's default tool).
   */
  toolId?: string;
  /** How many times this exact mapping has been affirmed */
  reinforcements: number;
  /** First time this mapping was recorded (epoch ms) */
  firstSeen: number;
  /** Most recent time this mapping was affirmed (epoch ms) */
  lastSeen: number;
}

/**
 * SemanticMapMatch — the result of a similar-intent lookup.
 */
export interface SemanticMapMatch {
  preference: LearnedPreference;
  /** Cosine similarity between the query intent and the remembered intent */
  similarity: number;
  /** Confidence boost to apply to the learned selector's candidate */
  boost: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SemanticMapOptions {
  /**
   * Minimum cosine similarity for a *similar* (non-exact) intent to draw on a
   * learned preference. Below this, a remembered choice is considered
   * unrelated and does not influence dispatch. Default 0.85.
   */
  similarityThreshold?: number;
  /**
   * Maximum confidence boost a fully-reinforced, near-identical intent can add
   * to the learned selector's candidate. Default 0.30.
   */
  maxBoost?: number;
  /**
   * Confidence assigned when the *exact* remembered intent recurs. This resolves
   * the learned selector directly, bypassing vector search. Default 0.97 (EXACT
   * tier — the user told us this mapping is correct).
   */
  exactConfidence?: number;
  /**
   * Ceiling on any boosted candidate confidence, so a learned preference never
   * fabricates a perfect score for a merely-similar intent. Default 0.98.
   */
  boostCeiling?: number;
  /**
   * Reinforcement half-life for the boost curve. The reinforcement factor is
   * `n / (n + halfLife)`, so with the default of 2: one affirmation → 0.33,
   * two → 0.50, three → 0.60, asymptotically approaching 1. Default 2.
   */
  reinforcementHalfLife?: number;
  /** Maximum number of learned preferences to retain (LRU eviction). Default 1000. */
  maxEntries?: number;
}

const DEFAULTS: Required<SemanticMapOptions> = {
  similarityThreshold: 0.85,
  maxBoost: 0.3,
  exactConfidence: 0.97,
  boostCeiling: 0.98,
  reinforcementHalfLife: 2,
  maxEntries: 1000,
};

// ---------------------------------------------------------------------------
// SemanticMap
// ---------------------------------------------------------------------------

export class SemanticMap {
  /** Learned preferences keyed by SemanticMap.key(intentKey, selectorId, exact, toolId) */
  private prefs: Map<string, LearnedPreference> = new Map();
  /** Fast exact-lookup index: intentKey → key with the most reinforcements */
  private exactIndex: Map<string, string> = new Map();

  readonly similarityThreshold: number;
  readonly maxBoost: number;
  readonly exactConfidence: number;
  readonly boostCeiling: number;
  readonly reinforcementHalfLife: number;
  readonly maxEntries: number;

  constructor(options?: SemanticMapOptions) {
    this.similarityThreshold = options?.similarityThreshold ?? DEFAULTS.similarityThreshold;
    this.maxBoost = options?.maxBoost ?? DEFAULTS.maxBoost;
    this.exactConfidence = options?.exactConfidence ?? DEFAULTS.exactConfidence;
    this.boostCeiling = options?.boostCeiling ?? DEFAULTS.boostCeiling;
    this.reinforcementHalfLife = options?.reinforcementHalfLife ?? DEFAULTS.reinforcementHalfLife;
    this.maxEntries = options?.maxEntries ?? DEFAULTS.maxEntries;
  }

  get size(): number {
    return this.prefs.size;
  }

  private static key(intent: string, selectorId: string, exact = true, toolId?: string): string {
    const base = `${exact ? 'k' : 'v1'}\u0000${intent}\u0000${selectorId}`;
    return toolId === undefined ? base : `${base}\u0000${toolId}`;
  }

  /**
   * Reinforce a mapping from a disambiguated intent to the selector the user
   * chose (and, when given, the tool they chose through it). Idempotent per
   * (intent, selector, tool): repeated calls strengthen the mapping (higher
   * reinforcement count → larger future boost) rather than duplicating it.
   * `intent` is the intent text; it is normalized with intentKey(), so only
   * the same text (up to case, NFC form and whitespace) matches it exactly
   * later.
   */
  reinforce(
    intent: string,
    vector: Float32Array,
    selectorId: string,
    now: number = Date.now(),
    toolId?: string,
  ): LearnedPreference {
    const ikey = intentKey(intent);
    const key = SemanticMap.key(ikey, selectorId, true, toolId);
    const existing = this.prefs.get(key);

    let pref: LearnedPreference;
    if (existing) {
      existing.reinforcements += 1;
      existing.lastSeen = now;
      // Refresh the embedding — the embedder may have changed the vector.
      existing.vector = vector;
      pref = existing;
      // Re-insert to move to the most-recently-used position for LRU eviction.
      this.prefs.delete(key);
      this.prefs.set(key, existing);
    } else {
      pref = {
        intentKey: ikey,
        exact: true,
        vector,
        selectorId,
        ...(toolId !== undefined ? { toolId } : {}),
        reinforcements: 1,
        firstSeen: now,
        lastSeen: now,
      };
      this.prefs.set(key, pref);
      this.evictIfNeeded();
    }

    this.reindexExact(ikey);
    return pref;
  }

  /**
   * Exact fast-path: has the user disambiguated *this exact* intent (same
   * intentKey) before? Returns the strongest (most-reinforced) mapping for
   * it, or null.
   */
  lookupExact(intent: string): LearnedPreference | null {
    const key = this.exactIndex.get(intentKey(intent));
    if (!key) return null;
    return this.prefs.get(key) ?? null;
  }

  /**
   * Similar-intent lookup: find the learned preference whose remembered intent
   * is most similar to `vector`, provided it clears `similarityThreshold`.
   * Returns the preference, the similarity, and the confidence boost to apply.
   * Similarities are quantized (quantizeScore); equal ones are decided by
   * selector id, then intent key — never by insertion order.
   */
  lookupSimilar(vector: Float32Array, threshold?: number): SemanticMapMatch | null {
    const floor = threshold ?? this.similarityThreshold;
    let best: LearnedPreference | null = null;
    let bestSim = -Infinity;

    for (const pref of this.prefs.values()) {
      if (pref.vector.length !== vector.length) continue;
      const sim = quantizeScore(cosineSimilarity(vector, pref.vector));
      if (sim < floor) continue;
      if (sim > bestSim || (sim === bestSim && best !== null && SemanticMap.before(pref, best))) {
        best = pref;
        bestSim = sim;
      }
    }

    if (!best) return null;
    return {
      preference: best,
      similarity: bestSim,
      boost: this.computeBoost(bestSim, best.reinforcements),
    };
  }

  /**
   * Confidence boost for a similar-intent hit. Grows with both similarity to
   * the remembered intent and how many times the mapping has been affirmed,
   * saturating at `maxBoost`.
   */
  computeBoost(similarity: number, reinforcements: number): number {
    const reinforcementFactor =
      reinforcements / (reinforcements + this.reinforcementHalfLife);
    return this.maxBoost * similarity * reinforcementFactor;
  }

  /** Deterministic tie order for similar-intent lookups. */
  private static before(a: LearnedPreference, b: LearnedPreference): boolean {
    if (a.selectorId !== b.selectorId) return a.selectorId < b.selectorId;
    if (a.intentKey !== b.intentKey) return a.intentKey < b.intentKey;
    return (a.toolId ?? '') < (b.toolId ?? '');
  }

  /** Every learned preference (most-recently-used last). */
  entries(): ReadonlyArray<LearnedPreference> {
    return Array.from(this.prefs.values());
  }

  /** Forget every learned preference. */
  clear(): void {
    this.prefs.clear();
    this.exactIndex.clear();
  }

  // -------------------------------------------------------------------------
  // Persistence — let a host app carry learned preferences across sessions
  // -------------------------------------------------------------------------

  toJSON(): SerializedSemanticMap {
    return {
      version: 2,
      preferences: Array.from(this.prefs.values()).map(p => ({
        intentKey: p.intentKey,
        ...(p.exact ? {} : { exact: false as const }),
        vector: Array.from(p.vector),
        selectorId: p.selectorId,
        ...(p.toolId !== undefined ? { toolId: p.toolId } : {}),
        reinforcements: p.reinforcements,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
      })),
    };
  }

  /**
   * Restore a map. Version 2 restores exactly. Version 1 (0.x) entries were
   * keyed by canonicalize(), which erased negations and non-Latin text, so
   * they are imported for similar-intent boosts only (`exact: false`).
   */
  static fromJSON(data: SerializedSemanticMap | SerializedSemanticMapV1, options?: SemanticMapOptions): SemanticMap {
    const map = new SemanticMap(options);
    for (const p of data.preferences ?? []) {
      const legacy = data.version === 1 || !('intentKey' in p);
      const exact = !legacy && (p as SerializedPreference).exact !== false;
      const ikey = legacy ? (p as { intentCanonical: string }).intentCanonical : (p as SerializedPreference).intentKey;
      const toolId = legacy ? undefined : (p as SerializedPreference).toolId;
      const pref: LearnedPreference = {
        intentKey: ikey,
        exact,
        vector: Float32Array.from(p.vector),
        selectorId: p.selectorId,
        ...(typeof toolId === 'string' ? { toolId } : {}),
        reinforcements: p.reinforcements,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
      };
      map.prefs.set(SemanticMap.key(ikey, p.selectorId, exact, pref.toolId), pref);
    }
    for (const pref of map.prefs.values()) {
      if (pref.exact) map.reindexExact(pref.intentKey);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Point the exact index at the most-reinforced mapping for an intent. */
  private reindexExact(ikey: string): void {
    let bestKey: string | undefined;
    let bestScore = -Infinity;
    for (const [key, pref] of this.prefs) {
      if (!pref.exact || pref.intentKey !== ikey) continue;
      // Prefer more reinforcements, then more recent.
      const score = pref.reinforcements * 1e15 + pref.lastSeen;
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    if (bestKey) this.exactIndex.set(ikey, bestKey);
    else this.exactIndex.delete(ikey);
  }

  /** Evict the least-recently-used preference when over capacity. */
  private evictIfNeeded(): void {
    while (this.prefs.size > this.maxEntries) {
      const oldestKey = this.prefs.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const evicted = this.prefs.get(oldestKey);
      this.prefs.delete(oldestKey);
      if (evicted?.exact) this.reindexExact(evicted.intentKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization shape
// ---------------------------------------------------------------------------

export interface SerializedPreference {
  /** intentKey() of the taught intent */
  intentKey: string;
  /** false for entries imported from a version 1 map (similar-intent only) */
  exact?: false;
  vector: number[];
  selectorId: string;
  /** Tool chosen through the selector (absent: the selector's default tool) */
  toolId?: string;
  reinforcements: number;
  firstSeen: number;
  lastSeen: number;
}

export interface SerializedSemanticMap {
  version: 2;
  preferences: SerializedPreference[];
}

/** The 0.x format, keyed by canonicalize(); readable by fromJSON. */
export interface SerializedSemanticMapV1 {
  version: 1;
  preferences: Array<{
    intentCanonical: string;
    vector: number[];
    selectorId: string;
    reinforcements: number;
    firstSeen: number;
    lastSeen: number;
  }>;
}
