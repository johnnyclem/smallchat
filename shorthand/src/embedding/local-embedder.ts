import type { Embedder } from './types.js';

/**
 * LocalEmbedder — generates embeddings using a local ONNX model.
 *
 * In v0.0.1, this provides a simple TF-IDF-like embedding as a fallback
 * when the ONNX runtime isn't available. The real implementation will
 * use all-MiniLM-L6-v2 or similar via onnxruntime-node.
 */
export class LocalEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions = 384) {
    this.dimensions = dimensions;
  }

  /**
   * Embed a single text string.
   *
   * v0.0.1: Uses a deterministic hash-based embedding that preserves
   * some semantic structure through character n-gram hashing.
   * This is NOT a real semantic embedding — it's a placeholder that
   * allows the dispatch pipeline to function end-to-end.
   */
  async embed(text: string): Promise<Float32Array> {
    return hashEmbed(text, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

/**
 * Simple hash-based embedding for v0.0.1.
 * Uses character trigram hashing to produce a fixed-dimension vector.
 * Not semantically meaningful, but deterministic and fast.
 */
function hashEmbed(text: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = normalized.split(/\s+/).filter(Boolean);

  // Word-level hashing
  for (const word of words) {
    const h = fnv1a(word);
    const idx = Math.abs(h) % dimensions;
    vector[idx] += 1.0;

    // Character trigrams for sub-word similarity
    for (let i = 0; i <= word.length - 3; i++) {
      const trigram = word.slice(i, i + 3);
      const tIdx = Math.abs(fnv1a(trigram)) % dimensions;
      vector[tIdx] += 0.5;
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= norm;
    }
  }

  return vector;
}

/** FNV-1a hash for strings */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0;
  }
  return hash;
}
