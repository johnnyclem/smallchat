import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteVectorIndex } from './sqlite-vector-index.js';

function randomNormalizedVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = Math.random() - 0.5;
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i]*a[i]; nb += b[i]*b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe('SqliteVectorIndex', () => {
  let index: SqliteVectorIndex;

  beforeEach(() => {
    index = new SqliteVectorIndex(':memory:', 384);
  });

  afterEach(() => {
    index.close();
  });

  it('starts empty', () => {
    expect(index.size()).toBe(0);
  });

  it('insert and size', () => {
    index.insert('a', randomNormalizedVec(384));
    index.insert('b', randomNormalizedVec(384));
    expect(index.size()).toBe(2);
  });

  it('search returns the inserted vector itself as closest', () => {
    const v = randomNormalizedVec(384);
    index.insert('test', v);
    const results = index.search(v, 1, 0.99);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('test');
    expect(results[0].distance).toBeCloseTo(0, 2);
  });

  it('search respects threshold', () => {
    const v1 = randomNormalizedVec(384);
    const v2 = randomNormalizedVec(384);
    index.insert('a', v1);
    index.insert('b', v2);

    // Searching with very high threshold should only return near-identical
    const results = index.search(v1, 10, 0.999);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('a');
  });

  it('search respects topK', () => {
    for (let i = 0; i < 20; i++) {
      index.insert(`v${i}`, randomNormalizedVec(384));
    }
    const q = randomNormalizedVec(384);
    const results = index.search(q, 5, 0.0);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('search returns results sorted by distance', () => {
    for (let i = 0; i < 10; i++) {
      index.insert(`v${i}`, randomNormalizedVec(384));
    }
    const q = randomNormalizedVec(384);
    const results = index.search(q, 10, 0.0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it('remove works', () => {
    const v = randomNormalizedVec(384);
    index.insert('removeme', v);
    expect(index.size()).toBe(1);
    index.remove('removeme');
    expect(index.size()).toBe(0);
  });

  it('upsert overwrites existing entries', () => {
    const v1 = randomNormalizedVec(384);
    const v2 = randomNormalizedVec(384);
    index.insert('same-id', v1);
    index.insert('same-id', v2);
    expect(index.size()).toBe(1);

    // Should find v2, not v1
    const results = index.search(v2, 1, 0.99);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('same-id');
  });

  it('rejects dimension mismatch on insert', () => {
    expect(() => {
      index.insert('bad', new Float32Array(128));
    }).toThrow(/dimension mismatch/);
  });

  it('rejects dimension mismatch on search', () => {
    expect(() => {
      index.search(new Float32Array(128), 5, 0.5);
    }).toThrow(/dimension mismatch/);
  });

  it('batch insert works', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `batch-${i}`,
      vector: randomNormalizedVec(384),
    }));
    index.insertBatch(entries);
    expect(index.size()).toBe(100);
  });

  it('batch insert is transactional (all or nothing)', () => {
    const entries = [
      { id: 'ok', vector: randomNormalizedVec(384) },
      { id: 'bad', vector: new Float32Array(128) }, // wrong dimension
    ];
    expect(() => index.insertBatch(entries)).toThrow(/dimension mismatch/);
    expect(index.size()).toBe(0); // rolled back
  });

  it('stats returns correct info', () => {
    index.insert('a', randomNormalizedVec(384));
    const stats = index.stats();
    expect(stats.count).toBe(1);
    expect(stats.dimensions).toBe(384);
  });

  it('compact does not throw', () => {
    index.insert('a', randomNormalizedVec(384));
    expect(() => index.compact()).not.toThrow();
  });

  it('performance: 10k insert + search', () => {
    const entries = Array.from({ length: 10_000 }, (_, i) => ({
      id: `perf-${i}`,
      vector: randomNormalizedVec(384),
    }));

    const insertStart = performance.now();
    index.insertBatch(entries);
    const insertElapsed = performance.now() - insertStart;

    expect(index.size()).toBe(10_000);

    // Search performance
    const q = randomNormalizedVec(384);
    const searchStart = performance.now();
    const results = index.search(q, 10, 0.5);
    const searchElapsed = performance.now() - searchStart;

    // Search should be fast (< 100ms even on slow CI)
    expect(searchElapsed).toBeLessThan(100);
    expect(results.length).toBeLessThanOrEqual(10);
  }, 30_000);
});
