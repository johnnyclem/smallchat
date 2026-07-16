/**
 * Vector math — shared primitives for embedding comparison.
 *
 * Cosine similarity is the core operation behind selector interning, vector
 * search, semantic rate limiting, and the semantic map. It lived as a private
 * copy in each of those modules; this is the single source of truth.
 */

/**
 * Cosine similarity between two Float32Arrays.
 *
 * Returns a value in [-1, 1] — but for normalized embeddings, effectively
 * [0, 1]. Mismatched dimensions yield 0 (treated as unrelated) rather than
 * throwing, so callers comparing heterogeneous vectors degrade gracefully.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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
