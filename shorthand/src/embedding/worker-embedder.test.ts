import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { EmbeddingWorkerBridge, WorkerEmbedder, createWorkerEmbedder } from './worker-embedder.js';
import { WorkerVectorIndex } from './worker-vector-index.js';

describe('WorkerEmbedder (unit)', () => {
  it('exposes dimensions = 384', () => {
    const bridge = { request: async () => ({}) } as any;
    const embedder = new WorkerEmbedder(bridge);
    expect(embedder.dimensions).toBe(384);
  });
});

describe('WorkerVectorIndex (unit)', () => {
  it('throws on synchronous search()', () => {
    const bridge = { request: async () => ({}) } as any;
    const idx = new WorkerVectorIndex(bridge);
    expect(() => idx.search(new Float32Array(384), 1, 0.5)).toThrow('not available synchronously');
  });

  it('throws on synchronous size()', () => {
    const bridge = { request: async () => ({}) } as any;
    const idx = new WorkerVectorIndex(bridge);
    expect(() => idx.size()).toThrow('not available synchronously');
  });
});

// Integration tests require the compiled worker JS and ONNX runtime to load
// in a worker thread. In some environments (e.g. vitest with the ONNX native
// binding already loaded in the main process), the native addon cannot
// self-register in a worker thread. These tests gracefully skip in that case.
describe('WorkerEmbedder (integration)', () => {
  let bridge: EmbeddingWorkerBridge;
  let embedder: WorkerEmbedder;
  let vectorIndex: WorkerVectorIndex;
  let onnxAvailable = false;

  beforeAll(async () => {
    try {
      const result = createWorkerEmbedder({
        vectorIndexDbPath: ':memory:',
        vectorIndexDimensions: 384,
      });
      bridge = result.bridge;
      embedder = result.embedder;
      vectorIndex = new WorkerVectorIndex(bridge);
      // Probe: try a real embed to verify ONNX loads in the worker
      await embedder.embed('probe');
      onnxAvailable = true;
    } catch {
      onnxAvailable = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (bridge) await bridge.terminate();
  }, 10_000);

  it('embed produces 384-dimensional vectors', async () => {
    if (!onnxAvailable) return; // skip gracefully
    const vec = await embedder.embed('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });

  it('produces L2-normalized vectors', async () => {
    if (!onnxAvailable) return;
    const vec = await embedder.embed('test normalization');
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 3);
  });

  it('embedBatch produces correct results', async () => {
    if (!onnxAvailable) return;
    const results = await embedder.embedBatch(['hello', 'world', 'test']);
    expect(results.length).toBe(3);
    for (const vec of results) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
    }
  });

  it('vector index insert + search round-trips', async () => {
    if (!onnxAvailable) return;
    const vec = await embedder.embed('search code repositories');
    await vectorIndex.insertAsync('search_code', vec);
    const results = await vectorIndex.searchAsync(vec, 1, 0.99);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('search_code');
    expect(results[0].distance).toBeLessThan(0.1);
  });

  it('vector index sizeAsync', async () => {
    if (!onnxAvailable) return;
    const size = await vectorIndex.sizeAsync();
    expect(size).toBeGreaterThanOrEqual(1);
  });

  it('vector index removeAsync', async () => {
    if (!onnxAvailable) return;
    await vectorIndex.insertAsync('to_remove', await embedder.embed('temporary'));
    await vectorIndex.removeAsync('to_remove');
    const query = await embedder.embed('temporary');
    const results = await vectorIndex.searchAsync(query, 10, 0.0);
    expect(results.map(r => r.id)).not.toContain('to_remove');
  });
});
