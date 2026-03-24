import { describe, it, expect, vi, afterEach } from 'vitest';
import { SemanticRateLimiter } from './semantic-rate-limiter.js';

/** Create a normalized random-ish vector (deterministic from seed) */
function makeVector(seed: number, dims = 8): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    // Simple deterministic pseudo-random
    v[i] = Math.sin(seed * (i + 1) * 1.618);
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

/** Create a vector similar to a base vector (add small noise) */
function makeSimilarVector(base: Float32Array, noise = 0.05): Float32Array {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    v[i] = base[i] + (Math.random() - 0.5) * noise;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

describe('SemanticRateLimiter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('volume-based throttling', () => {
    it('allows intents below the volume cap', () => {
      const limiter = new SemanticRateLimiter({ maxNovelIntents: 5 });

      for (let i = 0; i < 5; i++) {
        expect(limiter.check(`intent:${i}`)).toBe(true);
        limiter.record(`intent:${i}`, makeVector(i));
      }
    });

    it('throttles when volume cap is exceeded', () => {
      const limiter = new SemanticRateLimiter({ maxNovelIntents: 3 });

      for (let i = 0; i < 3; i++) {
        limiter.record(`intent:${i}`, makeVector(i));
      }

      // 4th intent should be throttled
      expect(limiter.check('intent:overflow')).toBe(false);
    });

    it('allows intents again after window expires', () => {
      const limiter = new SemanticRateLimiter({
        maxNovelIntents: 2,
        windowMs: 1000,
      });

      limiter.record('a', makeVector(1));
      limiter.record('b', makeVector(2));
      expect(limiter.check('c')).toBe(false);

      // Advance time past the window
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1100);

      expect(limiter.check('c')).toBe(true);
    });
  });

  describe('entropy-based throttling', () => {
    it('throttles when too many intents have high-entropy canonicals', () => {
      const limiter = new SemanticRateLimiter({
        maxNovelIntents: 100,
        maxCanonicalLength: 20,
        entropyFraction: 0.5,
        minSamplesForSimilarity: 4,
      });

      // Record 4 intents with long canonical forms (gibberish)
      const longCanonical = 'a'.repeat(50);
      for (let i = 0; i < 4; i++) {
        limiter.record(`${longCanonical}:${i}`, makeVector(i));
      }

      // Next check should fail — all 4 intents exceed maxCanonicalLength
      expect(limiter.check('another:long:intent')).toBe(false);
    });

    it('allows when entropy fraction is below threshold', () => {
      const limiter = new SemanticRateLimiter({
        maxNovelIntents: 100,
        maxCanonicalLength: 20,
        entropyFraction: 0.5,
        minSamplesForSimilarity: 4,
      });

      // 2 short + 2 long = 50% is exactly at threshold
      limiter.record('short', makeVector(1));
      limiter.record('also:short', makeVector(2));
      limiter.record('a'.repeat(50), makeVector(3));
      limiter.record('b'.repeat(50), makeVector(4));

      // At exactly 0.5 — should be throttled (>= check)
      expect(limiter.check('next')).toBe(false);

      // Reset and try below threshold
      limiter.reset();
      limiter.record('short', makeVector(1));
      limiter.record('also:short', makeVector(2));
      limiter.record('tiny', makeVector(3));
      limiter.record('b'.repeat(50), makeVector(4));

      // 1/4 = 0.25, below 0.5 threshold
      expect(limiter.check('next')).toBe(true);
    });
  });

  describe('similarity-based throttling', () => {
    it('passes when vectors are similar', () => {
      const limiter = new SemanticRateLimiter({
        minSamplesForSimilarity: 3,
        similarityFloor: 0.3,
      });

      const baseVector = makeVector(42);
      for (let i = 0; i < 5; i++) {
        limiter.record(`intent:${i}`, makeSimilarVector(baseVector, 0.01));
      }

      expect(limiter.checkSimilarity()).toBe(true);
    });

    it('throttles when vectors are dissimilar (random noise)', () => {
      const limiter = new SemanticRateLimiter({
        minSamplesForSimilarity: 5,
        similarityFloor: 0.5,
      });

      // Record many highly dissimilar vectors
      for (let i = 0; i < 10; i++) {
        limiter.record(`random:${i}`, makeVector(i * 1000));
      }

      expect(limiter.checkSimilarity()).toBe(false);
    });

    it('does not throttle similarity when below minSamples', () => {
      const limiter = new SemanticRateLimiter({
        minSamplesForSimilarity: 10,
        similarityFloor: 0.9,
      });

      // Only 3 samples — not enough to judge
      for (let i = 0; i < 3; i++) {
        limiter.record(`intent:${i}`, makeVector(i * 1000));
      }

      expect(limiter.checkSimilarity()).toBe(true);
    });
  });

  describe('metrics', () => {
    it('reports accurate metrics', () => {
      const limiter = new SemanticRateLimiter({
        maxNovelIntents: 50,
        maxCanonicalLength: 10,
      });

      limiter.record('short', makeVector(1));
      limiter.record('a'.repeat(20), makeVector(2));

      const metrics = limiter.getMetrics();
      expect(metrics.novelCount).toBe(2);
      expect(metrics.highEntropyFraction).toBe(0.5); // 1 of 2 > maxCanonicalLength
      expect(metrics.throttled).toBe(false);
      expect(metrics.windowResetsIn).toBeGreaterThan(0);
    });

    it('reports throttled=true when volume cap exceeded', () => {
      const limiter = new SemanticRateLimiter({ maxNovelIntents: 1 });
      limiter.record('a', makeVector(1));

      const metrics = limiter.getMetrics();
      expect(metrics.throttled).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const limiter = new SemanticRateLimiter({ maxNovelIntents: 2 });
      limiter.record('a', makeVector(1));
      limiter.record('b', makeVector(2));
      expect(limiter.check('c')).toBe(false);

      limiter.reset();
      expect(limiter.check('c')).toBe(true);

      const metrics = limiter.getMetrics();
      expect(metrics.novelCount).toBe(0);
      expect(metrics.averageSimilarity).toBe(1.0);
    });
  });

  describe('window eviction', () => {
    it('evicts old entries and restores capacity', () => {
      const baseTime = Date.now();
      let currentTime = baseTime;
      vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

      const limiter = new SemanticRateLimiter({
        maxNovelIntents: 3,
        windowMs: 5000,
      });

      // Fill up at t=0
      limiter.record('a', makeVector(1));
      limiter.record('b', makeVector(2));
      limiter.record('c', makeVector(3));
      expect(limiter.check('d')).toBe(false);

      // Advance 6 seconds — all entries expire
      currentTime = baseTime + 6000;

      expect(limiter.check('d')).toBe(true);
    });
  });
});
