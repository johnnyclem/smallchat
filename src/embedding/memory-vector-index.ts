import type { SelectorMatch, VectorIndex } from '../core/types.js';

/**
 * MemoryVectorIndex — an in-memory vector index using brute-force cosine similarity.
 *
 * v0.0.1 implementation. Will be replaced by sqlite-vec / HNSW for production.
 * Sufficient for small-to-medium registries (< 10K tools).
 */
export class MemoryVectorIndex implements VectorIndex {
  private vectors: Map<string, Float32Array> = new Map();

  insert(id: string, vector: Float32Array): void {
    this.vectors.set(id, vector);
  }

  search(query: Float32Array, topK: number, threshold: number): SelectorMatch[] {
    const results: SelectorMatch[] = [];

    for (const [id, vector] of this.vectors) {
      const similarity = cosineSimilarity(query, vector);
      const distance = 1 - similarity;

      if (similarity >= threshold) {
        results.push({ id, distance });
      }
    }

    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, topK);
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  size(): number {
    return this.vectors.size;
  }
}

/** Cosine similarity between two vectors */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

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
