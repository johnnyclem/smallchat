import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteArtifactStore } from './sqlite-artifact.js';
import type { SerializedArtifact } from './artifact.js';

function randomVec(dims: number): number[] {
  const v: number[] = [];
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const val = Math.random() - 0.5;
    v.push(val);
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  return v.map(x => x / norm);
}

function makeArtifact(toolCount: number): SerializedArtifact & Record<string, unknown> {
  const selectors: SerializedArtifact['selectors'] = {};
  const dispatchTables: SerializedArtifact['dispatchTables'] = {};

  const providers = new Map<string, Record<string, { providerId: string; toolName: string; transportType: string; inputSchema?: Record<string, unknown> }>>();

  for (let i = 0; i < toolCount; i++) {
    const providerId = `provider-${i % 3}`;
    const canonical = `${providerId}.tool_${i}`;
    const toolName = `tool_${i}`;

    selectors[canonical] = {
      canonical,
      parts: [providerId, toolName],
      arity: 1,
      vector: randomVec(384),
    };

    if (!providers.has(providerId)) providers.set(providerId, {});
    providers.get(providerId)![canonical] = {
      providerId,
      toolName,
      transportType: 'mcp',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    };
  }

  for (const [pid, methods] of providers) {
    dispatchTables[pid] = methods;
  }

  return {
    version: '0.1.0',
    timestamp: '2026-01-01T00:00:00.000Z',
    embedding: {
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      embedderType: 'onnx',
    },
    stats: {
      toolCount,
      uniqueSelectorCount: toolCount,
      providerCount: Math.min(toolCount, 3),
      collisionCount: 0,
      mergedCount: 0,
      channelCount: 0,
    },
    selectors,
    dispatchTables,
  } as unknown as SerializedArtifact & Record<string, unknown>;
}

describe('SqliteArtifactStore', () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    store = new SqliteArtifactStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('round-trips a small artifact', () => {
    const original = makeArtifact(5);
    store.save(original);

    const loaded = store.load() as SerializedArtifact & Record<string, unknown>;

    expect(loaded.version).toBe('0.1.0');
    expect((loaded.stats as { toolCount: number }).toolCount).toBe(5);
    expect(Object.keys(loaded.selectors)).toHaveLength(5);
    expect(Object.keys(loaded.dispatchTables)).toHaveLength(3);
  });

  it('preserves selector vectors', () => {
    const original = makeArtifact(2);
    store.save(original);
    const loaded = store.load();

    for (const [key, sel] of Object.entries(original.selectors)) {
      const loadedSel = loaded.selectors[key];
      expect(loadedSel).toBeDefined();
      expect(loadedSel.canonical).toBe(sel.canonical);
      expect(loadedSel.parts).toEqual(sel.parts);
      expect(loadedSel.arity).toBe(sel.arity);
      // Vectors should be approximately equal (float precision)
      expect(loadedSel.vector.length).toBe(384);
      for (let i = 0; i < 10; i++) {
        expect(loadedSel.vector[i]).toBeCloseTo(sel.vector[i], 4);
      }
    }
  });

  it('preserves dispatch table entries', () => {
    const original = makeArtifact(3);
    store.save(original);
    const loaded = store.load();

    for (const [pid, methods] of Object.entries(original.dispatchTables)) {
      expect(loaded.dispatchTables[pid]).toBeDefined();
      for (const [canonical, imp] of Object.entries(methods)) {
        const loadedImp = loaded.dispatchTables[pid][canonical];
        expect(loadedImp).toBeDefined();
        expect(loadedImp.providerId).toBe(imp.providerId);
        expect(loadedImp.toolName).toBe(imp.toolName);
        expect(loadedImp.transportType).toBe(imp.transportType);
      }
    }
  });

  it('preserves input schemas', () => {
    const original = makeArtifact(1);
    store.save(original);
    const loaded = store.load();

    const key = Object.keys(loaded.dispatchTables)[0];
    const canonical = Object.keys(loaded.dispatchTables[key])[0];
    const imp = loaded.dispatchTables[key][canonical];
    expect(imp.inputSchema).toEqual({ type: 'object', properties: { query: { type: 'string' } } });
  });

  it('preserves embedding metadata', () => {
    const original = makeArtifact(1);
    store.save(original);
    const loaded = store.load() as SerializedArtifact & Record<string, unknown>;

    const embedding = loaded.embedding as { model: string; dimensions: number; embedderType: string };
    expect(embedding.model).toBe('all-MiniLM-L6-v2');
    expect(embedding.dimensions).toBe(384);
    expect(embedding.embedderType).toBe('onnx');
  });

  it('preserves collisions', () => {
    const artifact = makeArtifact(2) as SerializedArtifact & Record<string, unknown>;
    (artifact as Record<string, unknown>).collisions = [
      { selectorA: 'a.tool_0', selectorB: 'b.tool_1', similarity: 0.91, hint: 'too similar' },
    ];

    store.save(artifact);
    const loaded = store.load() as Record<string, unknown>;

    const collisions = loaded.collisions as Array<{ selectorA: string; selectorB: string; similarity: number; hint: string }>;
    expect(collisions).toHaveLength(1);
    expect(collisions[0].selectorA).toBe('a.tool_0');
    expect(collisions[0].similarity).toBeCloseTo(0.91, 2);
  });

  it('preserves channels', () => {
    const artifact = makeArtifact(1) as SerializedArtifact & Record<string, unknown>;
    (artifact as Record<string, unknown>).channels = {
      'slack': { isChannel: true, twoWay: true, permissionRelay: false },
    };

    store.save(artifact);
    const loaded = store.load() as Record<string, unknown>;

    const channels = loaded.channels as Record<string, { isChannel: boolean }>;
    expect(channels).toBeDefined();
    expect(channels['slack'].isChannel).toBe(true);
  });

  it('save replaces previous artifact', () => {
    const artifact1 = makeArtifact(3);
    store.save(artifact1);
    expect(store.selectorCount()).toBe(3);

    const artifact2 = makeArtifact(7);
    store.save(artifact2);
    expect(store.selectorCount()).toBe(7);

    const loaded = store.load();
    expect((loaded.stats as { toolCount: number }).toolCount).toBe(7);
  });

  it('allVectors returns Float32Array entries', () => {
    const artifact = makeArtifact(5);
    store.save(artifact);

    const vectors = store.allVectors();
    expect(vectors).toHaveLength(5);
    for (const v of vectors) {
      expect(v.vector).toBeInstanceOf(Float32Array);
      expect(v.vector.length).toBe(384);
    }
  });

  it('handles artifact with no optional fields', () => {
    const minimal: SerializedArtifact = {
      version: '0.1.0',
      stats: {
        toolCount: 0,
        uniqueSelectorCount: 0,
        providerCount: 0,
        collisionCount: 0,
      },
      selectors: {},
      dispatchTables: {},
    };

    store.save(minimal);
    const loaded = store.load();

    expect(loaded.version).toBe('0.1.0');
    expect(Object.keys(loaded.selectors)).toHaveLength(0);
    expect(Object.keys(loaded.dispatchTables)).toHaveLength(0);
  });

  it('performance: 1000 tools round-trip', () => {
    const artifact = makeArtifact(1000);

    const saveStart = performance.now();
    store.save(artifact);
    const saveMs = performance.now() - saveStart;

    const loadStart = performance.now();
    const loaded = store.load();
    const loadMs = performance.now() - loadStart;

    expect((loaded.stats as { toolCount: number }).toolCount).toBe(1000);
    expect(Object.keys(loaded.selectors)).toHaveLength(1000);

    // Both save and load should be fast (<5s even on slow CI)
    expect(saveMs).toBeLessThan(5000);
    expect(loadMs).toBeLessThan(5000);
  }, 30_000);
});
