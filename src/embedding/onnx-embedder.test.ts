import { describe, it, expect, beforeAll } from 'vitest';
import { ONNXEmbedder } from './onnx-embedder.js';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

describe('ONNXEmbedder', () => {
  let embedder: ONNXEmbedder;

  beforeAll(async () => {
    embedder = new ONNXEmbedder();
    // Wait for initialization (first embed triggers it)
    await embedder.embed('warmup');
  }, 30_000);

  it('produces 384-dimensional vectors', async () => {
    const vec = await embedder.embed('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });

  it('produces L2-normalized vectors', async () => {
    const vec = await embedder.embed('test normalization');
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it('returns deterministic results for the same input', async () => {
    const v1 = await embedder.embed('deterministic test');
    const v2 = await embedder.embed('deterministic test');
    expect(cosine(v1, v2)).toBeCloseTo(1.0, 5);
  });

  it('gives high similarity for semantically similar texts', async () => {
    const v1 = await embedder.embed('search code repositories');
    const v2 = await embedder.embed('find source code');
    const sim = cosine(v1, v2);
    expect(sim).toBeGreaterThan(0.5);
  });

  it('gives low similarity for unrelated texts', async () => {
    const v1 = await embedder.embed('search code repositories');
    const v2 = await embedder.embed('cook pasta for dinner');
    const sim = cosine(v1, v2);
    expect(sim).toBeLessThan(0.3);
  });

  it('handles empty strings gracefully', async () => {
    const vec = await embedder.embed('');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });

  it('handles very long text (truncated to maxLength)', async () => {
    const longText = 'word '.repeat(500);
    const vec = await embedder.embed(longText);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });

  it('embedBatch produces correct results', async () => {
    const texts = ['hello world', 'search code', 'find documents'];
    const results = await embedder.embedBatch(texts);
    expect(results.length).toBe(3);
    for (const vec of results) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
    }

    // Verify batch results match individual results
    const single = await embedder.embed('hello world');
    expect(cosine(results[0], single)).toBeCloseTo(1.0, 5);
  });

  it('batch performance: 100 texts under 10 seconds', async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `test sentence number ${i}`);
    const start = performance.now();
    await embedder.embedBatch(texts);
    const elapsed = performance.now() - start;
    // Allow 10 seconds for CI environments
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it('caches embeddings for repeated texts', async () => {
    embedder.clearCache();
    await embedder.embed('cache test');
    expect(embedder.cacheCount).toBeGreaterThanOrEqual(1);

    // Second call should hit cache
    const start = performance.now();
    await embedder.embed('cache test');
    const elapsed = performance.now() - start;
    // Cache hit should be nearly instant
    expect(elapsed).toBeLessThan(5);
  });

  it('distinguishes tool-like intents semantically', async () => {
    const searchFiles = await embedder.embed('search for files');
    const findDocuments = await embedder.embed('find documents');
    const cookDinner = await embedder.embed('cook dinner recipe');

    // search/find should be more similar to each other than to cooking
    const searchFindSim = cosine(searchFiles, findDocuments);
    const searchCookSim = cosine(searchFiles, cookDinner);

    expect(searchFindSim).toBeGreaterThan(searchCookSim);
  });

  it('dimensions property returns 384', () => {
    expect(embedder.dimensions).toBe(384);
  });
});
