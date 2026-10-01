import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteArtifactStore } from './sqlite-artifact.js';
import { computeContentHash, validateArtifact } from '../artifact/format.js';
import { ArtifactVersionError, type ArtifactV1 } from '../artifact/types.js';
import { onnxFingerprint } from '../embedding/onnx-embedder.js';

function randomVec(dims: number): number[] {
  const v: number[] = [];
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const val = Math.random() - 0.5;
    v.push(val);
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  // Round-trip through float32 as the compiler does (Array.from(Float32Array)).
  return Array.from(new Float32Array(v.map(x => x / norm)));
}

/** A valid 1.0 artifact with `toolCount` tools spread over up to 3 providers. */
function makeArtifact(toolCount: number, extra: Partial<ArtifactV1> = {}): ArtifactV1 {
  const artifact: Omit<ArtifactV1, 'contentHash'> & { contentHash?: string } = {
    formatVersion: '1.0',
    embedder: onnxFingerprint(),
    providers: {},
    tools: {},
    selectors: {},
    collisions: [],
    duplicates: [],
    stats: { toolCount: 0, selectorCount: 0, providerCount: 0, collisionCount: 0, duplicateCount: 0 },
  };

  for (let i = 0; i < toolCount; i++) {
    const providerId = `provider-${i % 3}`;
    const name = `tool_${i}`;
    const id = `${providerId}/${name}`;
    const canonical = `${providerId}.${name}`;
    artifact.providers[providerId] ??= { id: providerId, name: providerId, transportType: 'mcp' };
    artifact.tools[id] = {
      id,
      providerId,
      name,
      description: `Tool number ${i}`,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      transportType: 'mcp',
      selector: canonical,
    };
    artifact.selectors[canonical] = { canonical, toolId: id, kind: 'tool', vector: randomVec(384) };
  }

  Object.assign(artifact, extra);
  artifact.stats = {
    toolCount,
    selectorCount: toolCount,
    providerCount: Object.keys(artifact.providers).length,
    collisionCount: artifact.collisions.length,
    duplicateCount: artifact.duplicates.length,
  };
  delete artifact.contentHash;
  return { ...artifact, contentHash: computeContentHash(artifact) } as ArtifactV1;
}

describe('SqliteArtifactStore', () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    store = new SqliteArtifactStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('round-trips an artifact exactly (content hash still verifies)', () => {
    const original = makeArtifact(4);
    store.save(original);
    const loaded = store.load();

    expect(loaded).toEqual(original);
    expect(() => validateArtifact(loaded)).not.toThrow();
  });

  it('preserves the embedder fingerprint', () => {
    store.save(makeArtifact(1));
    expect(store.load().embedder).toEqual(onnxFingerprint());
  });

  it('preserves collisions and channels', () => {
    const artifact = makeArtifact(2, {
      collisions: [{ selectorA: 'provider-0.tool_0', selectorB: 'provider-1.tool_1', similarity: 0.91, hint: 'too similar' }],
    });
    artifact.providers['provider-0'].channel = { isChannel: true, twoWay: true, permissionRelay: false };
    const rehashed = { ...artifact, contentHash: computeContentHash(artifact) };

    store.save(rehashed);
    const loaded = store.load();

    expect(loaded.collisions).toEqual(rehashed.collisions);
    expect(loaded.providers['provider-0'].channel?.isChannel).toBe(true);
    expect(() => validateArtifact(loaded)).not.toThrow();
  });

  it('save replaces previous artifact', () => {
    store.save(makeArtifact(3));
    expect(store.selectorCount()).toBe(3);

    store.save(makeArtifact(7));
    expect(store.selectorCount()).toBe(7);
    expect(store.load().stats.toolCount).toBe(7);
  });

  it('allVectors returns Float32Array entries', () => {
    store.save(makeArtifact(5));

    const vectors = store.allVectors();
    expect(vectors).toHaveLength(5);
    for (const v of vectors) {
      expect(v.vector).toBeInstanceOf(Float32Array);
      expect(v.vector.length).toBe(384);
    }
  });

  it('handles an empty artifact', () => {
    const empty = makeArtifact(0);
    store.save(empty);
    expect(store.load()).toEqual(empty);
  });

  it('refuses a database written by 0.x', () => {
    const legacy = new SqliteArtifactStore(':memory:');
    // 0.x stored a 'version' metadata row and no format_version.
    (legacy as unknown as { db: { exec(sql: string): void } }).db.exec(
      "INSERT INTO metadata(key, value) VALUES ('version', '0.5.0')",
    );
    expect(() => legacy.load()).toThrow(ArtifactVersionError);
    legacy.close();
  });

  it('performance: 1000 tools round-trip', () => {
    const artifact = makeArtifact(1000);

    const saveStart = performance.now();
    store.save(artifact);
    const saveMs = performance.now() - saveStart;

    const loadStart = performance.now();
    const loaded = store.load();
    const loadMs = performance.now() - loadStart;

    expect(loaded.stats.toolCount).toBe(1000);
    expect(Object.keys(loaded.selectors)).toHaveLength(1000);

    // Both save and load should be fast (<5s even on slow CI)
    expect(saveMs).toBeLessThan(5000);
    expect(loadMs).toBeLessThan(5000);
  }, 30_000);
});
