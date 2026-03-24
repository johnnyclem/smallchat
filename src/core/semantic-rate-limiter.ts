/**
 * SemanticRateLimiter — prevents "Vector Flooding" DoS attacks.
 *
 * Monitors the stream of intents flowing through the Resolution Cache.
 * When it detects a burst of high-entropy, low-similarity intents — the
 * signature of an attacker probing random garbage to exhaust the embedder
 * — it throttles further embedding requests.
 *
 * Detection heuristics:
 *   1. Sliding window of recent intent vectors (default 60s)
 *   2. Cross-similarity: average pairwise cosine similarity in the window
 *      — legitimate traffic clusters around known tools (high similarity)
 *      — flooding traffic is random noise (low similarity)
 *   3. Volume: raw count of novel (cache-miss) intents in the window
 *   4. Entropy estimate: canonical form length variance as a proxy for
 *      gibberish detection (attackers produce long random strings)
 *
 * When throttled, the limiter rejects new embedding requests until the
 * window drains below the threshold. Callers receive a `null` signal
 * and can return an error without touching the embedder.
 */

export interface SemanticRateLimiterOptions {
  /** Sliding window duration in milliseconds (default: 60_000) */
  windowMs?: number;
  /** Max novel (cache-miss) intents per window before checking similarity (default: 100) */
  maxNovelIntents?: number;
  /** Similarity floor — if average pairwise similarity drops below this, throttle (default: 0.3) */
  similarityFloor?: number;
  /** Min samples before similarity check kicks in (default: 10) */
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

interface WindowEntry {
  timestamp: number;
  vector: Float32Array;
  canonicalLength: number;
}

export class SemanticRateLimiter {
  private readonly windowMs: number;
  private readonly maxNovelIntents: number;
  private readonly similarityFloor: number;
  private readonly minSamplesForSimilarity: number;
  private readonly maxCanonicalLength: number;
  private readonly entropyFraction: number;

  private window: WindowEntry[] = [];
  /** Cached pairwise similarity sum to avoid O(n²) recomputation */
  private pairwiseSimilaritySum = 0;
  private pairwiseCount = 0;

  constructor(options?: SemanticRateLimiterOptions) {
    this.windowMs = options?.windowMs ?? 60_000;
    this.maxNovelIntents = options?.maxNovelIntents ?? 100;
    this.similarityFloor = options?.similarityFloor ?? 0.3;
    this.minSamplesForSimilarity = options?.minSamplesForSimilarity ?? 10;
    this.maxCanonicalLength = options?.maxCanonicalLength ?? 200;
    this.entropyFraction = options?.entropyFraction ?? 0.5;
  }

  /**
   * Check whether a new intent should be allowed through to the embedder.
   *
   * Call this BEFORE embedding. If it returns false, the intent is being
   * throttled — return an error to the caller without invoking the embedder.
   *
   * @param canonical - The canonicalized intent string
   * @returns true if allowed, false if throttled
   */
  check(canonical: string): boolean {
    this.evictStale();

    // Hard volume cap — too many novel intents regardless of similarity
    if (this.window.length >= this.maxNovelIntents) {
      return false;
    }

    // Entropy check — if too many recent intents look like gibberish, throttle
    if (this.window.length >= this.minSamplesForSimilarity) {
      const highEntropyCount = this.window.filter(
        e => e.canonicalLength > this.maxCanonicalLength,
      ).length;
      const fraction = highEntropyCount / this.window.length;
      if (fraction >= this.entropyFraction) {
        return false;
      }
    }

    return true;
  }

  /**
   * Record an intent that was just embedded (post-embedding).
   *
   * Call this AFTER embedding succeeds. The vector is stored in the
   * sliding window for cross-similarity analysis. The next `check()`
   * call uses this data to detect flooding patterns.
   */
  record(canonical: string, vector: Float32Array): void {
    this.evictStale();

    const entry: WindowEntry = {
      timestamp: Date.now(),
      vector,
      canonicalLength: canonical.length,
    };

    // Update incremental pairwise similarity with all existing entries
    for (const existing of this.window) {
      const sim = cosineSimilarity(vector, existing.vector);
      this.pairwiseSimilaritySum += sim;
      this.pairwiseCount++;
    }

    this.window.push(entry);
  }

  /**
   * Check similarity-based throttle. Separate from `check()` because
   * we need the vector (post-embedding) to compute similarity.
   *
   * Call this AFTER embedding but BEFORE expensive downstream work
   * (vector index search, cache store). Returns false if the recent
   * traffic pattern looks like flooding.
   */
  checkSimilarity(): boolean {
    if (this.window.length < this.minSamplesForSimilarity) {
      return true; // Not enough data to judge
    }

    const avgSimilarity = this.pairwiseCount > 0
      ? this.pairwiseSimilaritySum / this.pairwiseCount
      : 1.0;

    return avgSimilarity >= this.similarityFloor;
  }

  /**
   * Get current flooding metrics for monitoring/debugging.
   */
  getMetrics(): FloodingMetrics {
    this.evictStale();

    const avgSimilarity = this.pairwiseCount > 0
      ? this.pairwiseSimilaritySum / this.pairwiseCount
      : 1.0;

    const highEntropyCount = this.window.filter(
      e => e.canonicalLength > this.maxCanonicalLength,
    ).length;

    const oldestTimestamp = this.window.length > 0
      ? this.window[0].timestamp
      : Date.now();
    const windowResetsIn = Math.max(
      0,
      (oldestTimestamp + this.windowMs) - Date.now(),
    );

    const throttled = !this.check('') || !this.checkSimilarity();

    return {
      novelCount: this.window.length,
      averageSimilarity: avgSimilarity,
      highEntropyFraction: this.window.length > 0
        ? highEntropyCount / this.window.length
        : 0,
      throttled,
      windowResetsIn,
    };
  }

  /**
   * Reset the limiter — clear all state.
   */
  reset(): void {
    this.window = [];
    this.pairwiseSimilaritySum = 0;
    this.pairwiseCount = 0;
  }

  /** Evict entries older than the sliding window */
  private evictStale(): void {
    const cutoff = Date.now() - this.windowMs;
    let evicted = 0;

    while (this.window.length > 0 && this.window[0].timestamp < cutoff) {
      const removed = this.window.shift()!;
      evicted++;

      // Recompute pairwise similarities excluding the evicted entry.
      // For correctness we subtract out all pairs involving the removed entry.
      // This is O(n) per eviction but evictions are amortized.
      for (const remaining of this.window) {
        const sim = cosineSimilarity(removed.vector, remaining.vector);
        this.pairwiseSimilaritySum -= sim;
        this.pairwiseCount--;
      }
    }
  }
}

/**
 * Cosine similarity between two Float32Arrays.
 * Returns value in [-1, 1] — but for normalized embeddings, [0, 1].
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
