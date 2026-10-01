/**
 * WorkerVectorIndex — a VectorIndex proxy that runs sqlite-vec queries
 * on a dedicated Worker Thread, keeping the main event loop free.
 *
 * Implements the VectorIndex interface with asynchronous search() and
 * size() (the interface allows a Promise), so it can back a ToolRuntime
 * directly:
 *
 *   const bridge = new EmbeddingWorkerBridge();
 *   const runtime = new ToolRuntime(new WorkerVectorIndex(bridge), new WorkerEmbedder(bridge));
 *
 * Shares an EmbeddingWorkerBridge with WorkerEmbedder so that both
 * ONNX inference and vector lookups run on the same off-main thread.
 */
import type { SelectorMatch, VectorIndex } from '../core/types.js';
import type { EmbeddingWorkerBridge } from './worker-embedder.js';

export class WorkerVectorIndex implements VectorIndex {
  private bridge: EmbeddingWorkerBridge;

  constructor(bridge: EmbeddingWorkerBridge) {
    this.bridge = bridge;
  }

  /**
   * Insert a vector. Note: the underlying VectorIndex.insert is synchronous,
   * but the worker proxy is async. Callers that need the synchronous signature
   * should use SqliteVectorIndex directly; this class is designed for the
   * runtime dispatch path where async is natural.
   */
  insert(id: string, vector: Float32Array): void {
    // Fire-and-forget to preserve the synchronous interface.
    // The worker processes messages in order, so subsequent searches
    // will see this insert.
    void this.bridge.request('vectorInsert', { id, vector });
  }

  /**
   * Async insert — use when you need to confirm the insert completed.
   */
  async insertAsync(id: string, vector: Float32Array): Promise<void> {
    await this.bridge.request('vectorInsert', { id, vector });
  }

  /**
   * Search on the worker. Inserts sent earlier are processed first (the
   * worker handles messages in order).
   */
  search(vector: Float32Array, topK: number, threshold: number): Promise<SelectorMatch[]> {
    return this.searchAsync(vector, topK, threshold);
  }

  /** Same as search(). */
  async searchAsync(vector: Float32Array, topK: number, threshold: number): Promise<SelectorMatch[]> {
    const data = await this.bridge.request('vectorSearch', {
      query: vector,
      topK,
      threshold,
    });
    return data.results as SelectorMatch[];
  }

  remove(id: string): void {
    void this.bridge.request('vectorRemove', { id });
  }

  async removeAsync(id: string): Promise<void> {
    await this.bridge.request('vectorRemove', { id });
  }

  /** Number of vectors in the worker's index. */
  size(): Promise<number> {
    return this.sizeAsync();
  }

  async sizeAsync(): Promise<number> {
    const data = await this.bridge.request('vectorSize');
    return data.size as number;
  }

  async insertBatch(entries: Array<{ id: string; vector: Float32Array }>): Promise<void> {
    await this.bridge.request('vectorInsertBatch', { entries });
  }

  async stats(): Promise<{ count: number; dimensions: number; dbPath: string }> {
    return await this.bridge.request('vectorStats');
  }

  async compact(): Promise<void> {
    await this.bridge.request('vectorCompact');
  }

  async close(): Promise<void> {
    await this.bridge.request('vectorClose');
  }
}
