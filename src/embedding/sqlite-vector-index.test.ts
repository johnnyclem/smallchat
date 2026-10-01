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

// ---------------------------------------------------------------------------
// SC-INF-02 — vec0 defaulted to L2 distance, which search() read as cosine
// ---------------------------------------------------------------------------

describe('SC-INF-02: SqliteVectorIndex scores cosine distance', () => {
  /** Unit vector at exactly `cos` from e0 (completed along e1). */
  function atCosine(cos: number, dims: number): Float32Array {
    const v = new Float32Array(dims);
    v[0] = cos;
    v[1] = Math.sqrt(1 - cos * cos);
    return v;
  }

  it('returns 1 − cosine as the distance and filters on it', () => {
    const index = new SqliteVectorIndex(':memory:', 384);
    const q = atCosine(1, 384);
    index.insert('near', atCosine(0.9, 384));
    index.insert('far', atCosine(0.5, 384));

    const results = index.search(q, 5, 0.6);
    expect(results.map(r => r.id)).toEqual(['near']);
    expect(results[0].distance).toBeCloseTo(0.1, 5);
    index.close();
  });

  it('agrees with MemoryVectorIndex on non-identical vectors', async () => {
    const { MemoryVectorIndex } = await import('./memory-vector-index.js');
    const sqlite = new SqliteVectorIndex(':memory:', 384);
    const memory = new MemoryVectorIndex();
    for (let i = 0; i < 25; i++) {
      const v = randomNormalizedVec(384);
      sqlite.insert(`v${i}`, v);
      memory.insert(`v${i}`, v);
    }
    const q = randomNormalizedVec(384);
    const a = sqlite.search(q, 25, -1);
    const b = memory.search(q, 25, -1);
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id));
    for (let i = 0; i < a.length; i++) expect(a[i].distance).toBeCloseTo(b[i].distance, 5);
    sqlite.close();
  });

  it('rebuilds an existing L2 table (0.x / pre-cosine databases) in place', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const Database = (await import('better-sqlite3')).default;
    const sqliteVec = await import('sqlite-vec');

    const dir = mkdtempSync(join(tmpdir(), 'sc-vec-'));
    const path = join(dir, 'old.db');
    try {
      const db = new Database(path);
      sqliteVec.load(db);
      db.exec('CREATE VIRTUAL TABLE vec_selectors USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[4])');
      const near = new Float32Array([0.9, Math.sqrt(1 - 0.81), 0, 0]);
      db.prepare('INSERT INTO vec_selectors(id, embedding) VALUES (?, ?)').run('near', Buffer.from(near.buffer));
      db.close();

      const index = new SqliteVectorIndex(path, 4);
      const results = index.search(new Float32Array([1, 0, 0, 0]), 1, 0.6);
      expect(results.map(r => r.id)).toEqual(['near']);
      expect(results[0].distance).toBeCloseTo(0.1, 5);
      expect(index.size()).toBe(1);
      index.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
