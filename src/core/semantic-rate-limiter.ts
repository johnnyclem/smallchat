/**
 * SemanticRateLimiter — protects the embedder from "Vector Flooding" DoS.
 *
 * Opt-in: a ToolRuntime has one only when RuntimeOptions.rateLimiter is
 * set. State is kept per principal (the caller identity passed to
 * resolve/dispatch, e.g. an MCP session or API key; callers that pass none
 * share the "default" principal), so one client cannot exhaust another's
 * budget. A throttled intent resolves to outcome 'throttled' with a
 * retry-after; nothing is thrown through dispatch.
 *
 * Only novel intents count: an intent served from the resolution cache, a
 * pinned phrase or a learned exact preference is never embedded and never
 * consulted here.
 *
 * Detection heuristics, per principal:
 *   1. Sliding window of recent intent vectors (default 60s)
 *   2. Cross-similarity: average pairwise cosine similarity in the window
 *      — legitimate traffic clusters around known tools (high similarity)
 *      — flooding traffic is random noise (low similarity)
 *   3. Volume: raw count of novel (cache-miss) intents in the window
 *   4. Entropy estimate: canonical form length as a proxy for gibberish
 *      detection (attackers produce long random strings)
 *
 * When throttled, the limiter rejects new embedding requests from that
 * principal until its window drains below the thresholds.
 */

import { cosineSimilarity } from './vector-math.js';

/** The principal used when a caller does not identify itself. */
export const DEFAULT_PRINCIPAL = 'default';

export interface SemanticRateLimiterOptions {
  /** Sliding window duration in milliseconds (default: 60_000) */
  windowMs?: number;
  /** Max novel (cache-miss) intents per principal per window (default: 100) */
  maxNovelIntents?: number;
  /** Similarity floor — if a principal's average pairwise similarity drops below this, throttle (default: 0.3) */
  similarityFloor?: number;
  /** Min samples before the similarity and entropy checks kick in (default: 10) */
  minSamplesForSimilarity?: number;
  /** Max canonical length — intents longer than this are suspicious (default: 200) */
  maxCanonicalLength?: number;
  /** Fraction of recent intents exceeding maxCanonicalLength that triggers throttle (default: 0.5) */
  entropyFraction?: number;
}

export interface FloodingMetrics {
  /** Number of novel intents in the current window */
  novelCount: number;
  /** Average pairwise cosine similarity of recent vectors (0–1, higher = more coherent) */
  averageSimilarity: number;
  /** Fraction of intents with suspiciously long canonical forms */
  highEntropyFraction: number;
  /** Whether the limiter is currently throttling */
  throttled: boolean;
  /** Milliseconds until the oldest entry in the window expires */
  windowResetsIn: number;
}

/** Why an intent may or may not be embedded. */
export type RateLimitVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Which heuristic tripped */
      reason: 'volume' | 'entropy' | 'similarity';
      /** Milliseconds until the oldest window entry expires */
      retryAfterMs: number;
    };

interface WindowEntry {
  timestamp: number;
  vector: Float32Array;
  canonicalLength: number;
}

interface PrincipalWindow {
  entries: WindowEntry[];
  /** Cached pairwise similarity sum to avoid O(n²) recomputation */
  pairwiseSimilaritySum: number;
  pairwiseCount: number;
}

export class SemanticRateLimiter {
  private readonly windowMs: number;
  private readonly maxNovelIntents: number;
  private readonly similarityFloor: number;
  private readonly minSamplesForSimilarity: number;
  private readonly maxCanonicalLength: number;
  private readonly entropyFraction: number;

  private windows: Map<string, PrincipalWindow> = new Map();

  constructor(options?: SemanticRateLimiterOptions) {
    this.windowMs = options?.windowMs ?? 60_000;
    this.maxNovelIntents = options?.maxNovelIntents ?? 100;
    this.similarityFloor = options?.similarityFloor ?? 0.3;
    this.minSamplesForSimilarity = options?.minSamplesForSimilarity ?? 10;
    this.maxCanonicalLength = options?.maxCanonicalLength ?? 200;
    this.entropyFraction = options?.entropyFraction ?? 0.5;
  }

  /**
   * Whether a new intent from `principal` may be embedded, and if not, why
   * and for how long. Call this BEFORE embedding.
   *
   * @param canonical - The intent's text (or canonical form)
   * @param principal - Who is asking (default: DEFAULT_PRINCIPAL)
   */
  evaluate(canonical: string, principal: string = DEFAULT_PRINCIPAL): RateLimitVerdict {
    const window = this.window(principal, false);
    if (!window) return { allowed: true };
    const entries = window.entries;

    const deny = (reason: 'volume' | 'entropy' | 'similarity'): RateLimitVerdict => ({
      allowed: false,
      reason,
      retryAfterMs: Math.max(0, entries[0].timestamp + this.windowMs - Date.now()),
    });

    // Volume cap — too many novel intents from this principal
    if (entries.length >= this.maxNovelIntents) return deny('volume');

    if (entries.length >= this.minSamplesForSimilarity) {
      // Entropy — too many recent intents look like gibberish
      const highEntropyCount = entries.filter(e => e.canonicalLength > this.maxCanonicalLength).length;
      if (highEntropyCount / entries.length >= this.entropyFraction) return deny('entropy');
      // Similarity — recent intents are incoherent noise
      if (!this.similarityHealthy(window)) return deny('similarity');
    }

    return { allowed: true };
  }

  /**
   * Check whether a new intent should be allowed through to the embedder.
   * Same as `evaluate(...).allowed`.
   */
  check(canonical: string, principal: string = DEFAULT_PRINCIPAL): boolean {
    return this.evaluate(canonical, principal).allowed;
  }

  /**
   * Record an intent that was just embedded (post-embedding). The vector
   * joins the principal's sliding window for cross-similarity analysis.
   */
  record(canonical: string, vector: Float32Array, principal: string = DEFAULT_PRINCIPAL): void {
    const window = this.window(principal, true)!;

    // Update incremental pairwise similarity with all existing entries
    for (const existing of window.entries) {
      window.pairwiseSimilaritySum += cosineSimilarity(vector, existing.vector);
      window.pairwiseCount++;
    }

    window.entries.push({ timestamp: Date.now(), vector, canonicalLength: canonical.length });
  }

  /**
   * Whether the principal's recent traffic is coherent enough (average
   * pairwise similarity at or above the floor). True until there are
   * minSamplesForSimilarity samples.
   */
  checkSimilarity(principal: string = DEFAULT_PRINCIPAL): boolean {
    const window = this.window(principal, false);
    if (!window || window.entries.length < this.minSamplesForSimilarity) return true;
    return this.similarityHealthy(window);
  }

  /** Current flooding metrics for one principal, for monitoring/debugging. */
  getMetrics(principal: string = DEFAULT_PRINCIPAL): FloodingMetrics {
    const window = this.window(principal, false);
    const entries = window?.entries ?? [];
    const avgSimilarity = window && window.pairwiseCount > 0
      ? window.pairwiseSimilaritySum / window.pairwiseCount
      : 1.0;
    const highEntropyCount = entries.filter(e => e.canonicalLength > this.maxCanonicalLength).length;
    const oldestTimestamp = entries.length > 0 ? entries[0].timestamp : Date.now();

    return {
      novelCount: entries.length,
      averageSimilarity: avgSimilarity,
      highEntropyFraction: entries.length > 0 ? highEntropyCount / entries.length : 0,
      throttled: !this.check('', principal),
      windowResetsIn: Math.max(0, (oldestTimestamp + this.windowMs) - Date.now()),
    };
  }

  /** Principals with entries in the current window. */
  principals(): string[] {
    for (const principal of [...this.windows.keys()]) this.window(principal, false);
    return [...this.windows.keys()];
  }

  /** Clear one principal's state, or everyone's. */
  reset(principal?: string): void {
    if (principal === undefined) this.windows.clear();
    else this.windows.delete(principal);
  }

  private similarityHealthy(window: PrincipalWindow): boolean {
    const avgSimilarity = window.pairwiseCount > 0
      ? window.pairwiseSimilaritySum / window.pairwiseCount
      : 1.0;
    return avgSimilarity >= this.similarityFloor;
  }

  /** A principal's window with stale entries evicted (created on demand). */
  private window(principal: string, create: boolean): PrincipalWindow | undefined {
    let window = this.windows.get(principal);
    if (window) {
      this.evictStale(window);
      if (window.entries.length === 0 && !create) {
        this.windows.delete(principal);
        return undefined;
      }
    } else if (create) {
      window = { entries: [], pairwiseSimilaritySum: 0, pairwiseCount: 0 };
      this.windows.set(principal, window);
    }
    return window;
  }

  /** Evict entries older than the sliding window */
  private evictStale(window: PrincipalWindow): void {
    const cutoff = Date.now() - this.windowMs;
    while (window.entries.length > 0 && window.entries[0].timestamp < cutoff) {
      const removed = window.entries.shift()!;
      // Subtract out all pairs involving the removed entry. O(n) per
      // eviction, amortized.
      for (const remaining of window.entries) {
        window.pairwiseSimilaritySum -= cosineSimilarity(removed.vector, remaining.vector);
        window.pairwiseCount--;
      }
    }
  }
}
