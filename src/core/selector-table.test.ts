import { describe, it, expect } from 'vitest';
import { SelectorTable, canonicalize } from './selector-table.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';

describe('canonicalize', () => {
  it('converts natural language to colon-separated canonical form', () => {
    expect(canonicalize('find my recent documents')).toBe('find:recent:documents');
  });

  it('removes stop words', () => {
    expect(canonicalize('search for the latest issues')).toBe('search:latest:issues');
  });

  it('normalizes case and punctuation', () => {
    expect(canonicalize('Create a Bug Report!')).toBe('create:bug:report');
  });

  it('returns "unknown" for empty/stopword-only input', () => {
    expect(canonicalize('the a an')).toBe('unknown');
  });
});

describe('SelectorTable', () => {
  function createTable(threshold = 0.95) {
    const embedder = new LocalEmbedder(64);
    const index = new MemoryVectorIndex();
    return new SelectorTable(index, embedder, threshold);
  }

  it('interns a new selector', async () => {
    const table = createTable();
    const embedding = new Float32Array(64).fill(0.1);
    const sel = await table.intern(embedding, 'search:documents');

    expect(sel.canonical).toBe('search:documents');
    expect(sel.parts).toEqual(['search', 'documents']);
    expect(sel.arity).toBe(1);
    expect(table.size).toBe(1);
  });

  it('returns existing selector for same canonical name', async () => {
    const table = createTable();
    const embedding = new Float32Array(64).fill(0.1);

    const sel1 = await table.intern(embedding, 'search:documents');
    const sel2 = await table.intern(embedding, 'search:documents');

    expect(sel1).toBe(sel2); // Same reference
    expect(table.size).toBe(1);
  });

  it('resolves a natural language intent to a selector', async () => {
    const table = createTable();
    const sel = await table.resolve('search documents');

    expect(sel.canonical).toBe('search:documents');
    expect(sel.vector).toBeInstanceOf(Float32Array);
  });

  it('returns all interned selectors', async () => {
    const table = createTable();

    // Use vectors that are far apart so they won't be deduplicated
    const v1 = new Float32Array(64);
    v1[0] = 1.0;
    const v2 = new Float32Array(64);
    v2[32] = 1.0;

    await table.intern(v1, 'search:docs');
    await table.intern(v2, 'create:issue');

    const all = table.all();
    expect(all).toHaveLength(2);
  });
});
