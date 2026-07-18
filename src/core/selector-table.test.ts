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

  // Regression coverage for the HyperVault field report: SelectorTable.resolve()
  // (the runtime intent-resolution path) used to intern into the exact same
  // map/vector index as compiled tool selectors, so a user's own intent would
  // show up as a phantom "tool" in all() and as a self-match in vector search.
  describe('intent/tool selector separation', () => {
    it('tags selectors created via resolve() as intent provenance', async () => {
      const table = createTable();
      const sel = await table.resolve('search for projects in my workspace');
      expect(sel.provenance).toBe('intent');
    });

    it('tags selectors created via intern() as tool provenance by default', async () => {
      const table = createTable();
      const embedding = new Float32Array(64).fill(0.1);
      const sel = await table.intern(embedding, 'search:projects:workspace');
      expect(sel.provenance).toBe('tool');
    });

    it('excludes resolved intents from all() by default', async () => {
      const table = createTable();
      const toolEmbedding = new Float32Array(64);
      toolEmbedding[0] = 1.0;
      await table.intern(toolEmbedding, 'create:project');

      await table.resolve('search for projects in my workspace');

      const tools = table.all();
      expect(tools.map(s => s.canonical)).toEqual(['create:project']);
      expect(tools.some(s => s.canonical === 'search:projects:workspace')).toBe(false);
    });

    it('includes intent selectors from all() only when explicitly requested', async () => {
      const table = createTable();
      await table.resolve('search for projects in my workspace');

      expect(table.all()).toHaveLength(0);
      expect(table.all({ includeIntents: true })).toHaveLength(1);
    });

    it('searchTools() does not return the caller\'s own resolved intent as a match', async () => {
      const table = createTable();
      const toolEmbedding = new Float32Array(64);
      toolEmbedding[0] = 1.0;
      const toolSel = await table.intern(toolEmbedding, 'create:project');

      // Resolving the intent interns it into the same vector index a tool
      // search will consult — this used to make the intent match itself at
      // ~1.0 similarity and surface as a "did you mean?" option.
      const intentSel = await table.resolve('search for projects in my workspace');

      const matches = await table.searchTools(intentSel.vector, 5, 0.0);
      expect(matches.some(m => m.id === 'search:projects:workspace')).toBe(false);
      // A genuinely similar tool selector must still be found by tool search.
      expect(matches.some(m => m.id === toolSel.canonical)).toBe(true);
      // Sanity check: the raw (unfiltered) index does return the intent —
      // proving searchTools() is doing real filtering, not just an empty index.
      const rawMatches = await table.nearest(intentSel.vector, 5, 0.0);
      expect(rawMatches.some(m => m.id === 'search:projects:workspace')).toBe(true);
    });

    it('bounds the number of retained intent selectors via LRU eviction', async () => {
      const embedder = new LocalEmbedder(64);
      const index = new MemoryVectorIndex();
      const table = new SelectorTable(index, embedder, 0.95, undefined, 3);

      await table.resolve('first distinct intent alpha');
      await table.resolve('second distinct intent bravo');
      await table.resolve('third distinct intent charlie');
      await table.resolve('fourth distinct intent delta');

      const withIntents = table.all({ includeIntents: true });
      expect(withIntents).toHaveLength(3);
      expect(withIntents.some(s => s.canonical.includes('first'))).toBe(false);
      expect(withIntents.some(s => s.canonical.includes('delta'))).toBe(true);
    });
  });
});
