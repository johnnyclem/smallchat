import { describe, it, expect } from 'vitest';
import { SelectorTable, canonicalize, intentKey } from './selector-table.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';

describe('canonicalize (display only)', () => {
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

  it('keeps letters and digits of every script', () => {
    expect(canonicalize('查找 航班')).toBe('查找:航班');
    expect(canonicalize('Café crème')).toBe('café:crème');
  });
});

describe('intentKey', () => {
  it('is the full text, NFC, trimmed, whitespace-collapsed and lower-cased', () => {
    expect(intentKey('  Do NOT   delete\tthe logs ')).toBe('do not delete the logs');
    expect(intentKey('cafe\u0301')).toBe('caf\u00e9');
    expect(intentKey('查找航班')).toBe('查找航班');
  });

  it('is idempotent', () => {
    const k = intentKey(' Ångström  UNITS ');
    expect(intentKey(k)).toBe(k);
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

  // Regression coverage for the HyperVault field report and SC-INF-13:
  // resolve() used to intern runtime intents into the same map and vector
  // index as compiled tool selectors. It now embeds the intent and leaves
  // the table untouched.
  describe('intent/tool selector separation', () => {
    it('tags selectors created via resolve() as intent provenance, with an identity key', async () => {
      const table = createTable();
      const sel = await table.resolve('Search for projects in my workspace');
      expect(sel.provenance).toBe('intent');
      expect(sel.canonical).toBe('search:projects:workspace');
      expect(sel.key).toBe('search for projects in my workspace');
    });

    it('tags selectors created via intern() as tool provenance', async () => {
      const table = createTable();
      const embedding = new Float32Array(64).fill(0.1);
      const sel = await table.intern(embedding, 'search:projects:workspace');
      expect(sel.provenance).toBe('tool');
    });

    it('never adds a resolved intent to the table or the vector index', async () => {
      const embedder = new LocalEmbedder(64);
      const index = new MemoryVectorIndex();
      const table = new SelectorTable(index, embedder);
      const toolEmbedding = new Float32Array(64);
      toolEmbedding[0] = 1.0;
      await table.intern(toolEmbedding, 'create:project');

      await table.resolve('search for projects in my workspace');
      await table.resolve('search for projects in my workspace');

      expect(table.all().map(s => s.canonical)).toEqual(['create:project']);
      expect(table.size).toBe(1);
      expect(index.size()).toBe(1);
      expect(table.get('search:projects:workspace')).toBeUndefined();
    });

    it('searchTools() finds tools for an intent vector and nothing else', async () => {
      const table = createTable();
      const toolEmbedding = new Float32Array(64);
      toolEmbedding[0] = 1.0;
      const toolSel = await table.intern(toolEmbedding, 'create:project');

      const intentSel = await table.resolve('search for projects in my workspace');
      const matches = await table.searchTools(intentSel.vector, 5, 0.0);
      expect(matches.map(m => m.id)).toEqual([toolSel.canonical]);
    });

    it('searchTools() skips index rows that are not registered selectors', async () => {
      const index = new MemoryVectorIndex();
      const table = new SelectorTable(index, new LocalEmbedder(4));
      const v = new Float32Array([1, 0, 0, 0]);
      for (let i = 0; i < 10; i++) index.insert(`foreign:${i}`, v);
      table.register(new Float32Array([0.8, 0.6, 0, 0]), 'tool:a');
      const matches = await table.searchTools(v, 1, 0.5);
      expect(matches.map(m => m.id)).toEqual(['tool:a']);
    });
  });
});

describe('SelectorTable.register (compiled selectors)', () => {
  it('keeps two tools with identical embeddings as two selectors', async () => {
    const embedder = new LocalEmbedder(64);
    const table = new SelectorTable(new MemoryVectorIndex(), embedder);
    const vector = await embedder.embed('list issues in a repository');

    const a = table.register(vector, 'github.list_issues');
    const b = table.register(vector, 'github.list-issues');

    expect(a.canonical).toBe('github.list_issues');
    expect(b.canonical).toBe('github.list-issues');
    expect(table.all().map(s => s.canonical)).toEqual(['github.list_issues', 'github.list-issues']);
  });

  it('is idempotent for the same canonical', async () => {
    const embedder = new LocalEmbedder(64);
    const table = new SelectorTable(new MemoryVectorIndex(), embedder);
    const vector = await embedder.embed('read a file');
    expect(table.register(vector, 'fs.read_file')).toBe(table.register(vector, 'fs.read_file'));
    expect(table.size).toBe(1);
  });
});
