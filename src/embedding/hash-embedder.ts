import type { Embedder, EmbedderFingerprint } from '../core/types.js';

/** Algorithm id recorded in artifact fingerprints for HashEmbedder vectors. */
export const HASH_EMBEDDER_MODEL = 'smallchat-hash-v1';

/**
 * HashEmbedder — a dependency-free, hash-based placeholder embedder for
 * development and tests.
 *
 * It hashes words and character trigrams into a fixed-size, L2-normalized
 * vector. The same text always yields the same vector, and texts that share
 * words/trigrams land close together, but it has no notion of meaning:
 * "delete a file" and "remove a document" are far apart. Use ONNXEmbedder
 * (the compile default) for real semantic matching.
 */
export class HashEmbedder implements Embedder {
  readonly dimensions: number;
  readonly fingerprint: EmbedderFingerprint;

  constructor(dimensions = 384) {
    this.dimensions = dimensions;
    this.fingerprint = hashFingerprint(dimensions);
  }

  /** Embed a single text string (word + trigram hashing; not semantic). */
  async embed(text: string): Promise<Float32Array> {
    return hashEmbed(text, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

/**
 * @deprecated Renamed to HashEmbedder in 1.0 — it was never an ONNX/local
 * model, only a hash placeholder. This alias will be removed in 2.0.
 */
export const LocalEmbedder = HashEmbedder;
/** @deprecated Use HashEmbedder. */
export type LocalEmbedder = HashEmbedder;

/** The fingerprint of a HashEmbedder with the given dimensions. */
export function hashFingerprint(dimensions = 384): EmbedderFingerprint {
  return {
    kind: 'hash',
    model: HASH_EMBEDDER_MODEL,
    modelSha256: null,
    dims: dimensions,
    maxLength: null,
    pooling: 'none',
    normalize: true,
  };
}

/**
 * Hash-based embedding: word and character-trigram hashing into a
 * fixed-dimension vector. Not semantically meaningful, but fast and the
 * same text always maps to the same vector.
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
