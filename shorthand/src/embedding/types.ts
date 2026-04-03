/**
 * Embedding Types — vendored interfaces for the embedding layer.
 *
 * These were originally defined in @smallchat/core's core/types.ts.
 * Vendored here so @shorthand/core has no dependency on smallchat.
 */

/** A match result from a vector similarity search. */
export interface SelectorMatch {
  id: string;
  distance: number;
}

/** Interface for generating semantic embeddings from text. */
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
}

/** Interface for a vector similarity index. */
export interface VectorIndex {
  insert(id: string, vector: Float32Array): void;
  search(vector: Float32Array, topK: number, threshold: number): SelectorMatch[] | Promise<SelectorMatch[]>;
  remove(id: string): void;
  size(): number | Promise<number>;
}
