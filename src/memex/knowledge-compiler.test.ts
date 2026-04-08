import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compile,
  cosineSimilarity,
  serializeKnowledgeBase,
  deserializeKnowledgeBase,
} from './knowledge-compiler.js';
import type { KnowledgeSchema, KnowledgeBase } from './types.js';
import type { Embedder, VectorIndex, SelectorMatch } from '../core/types.js';

// ---------------------------------------------------------------------------
// Mock embedder & vector index (same pattern as smallchat's testing package)
// ---------------------------------------------------------------------------

class MockEmbedder implements Embedder {
  readonly dimensions = 8;
  private callCount = 0;

  async embed(text: string): Promise<Float32Array> {
    // Deterministic pseudo-embedding based on text hash
    return this.hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  private hashToVector(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length && i < this.dimensions; i++) {
      vec[i % this.dimensions] += text.charCodeAt(i) / 256;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }
}

class MockVectorIndex implements VectorIndex {
  private entries = new Map<string, Float32Array>();

  insert(id: string, vector: Float32Array): void {
    this.entries.set(id, new Float32Array(vector));
  }

  search(query: Float32Array, topK: number, threshold: number): SelectorMatch[] {
    const results: SelectorMatch[] = [];
    for (const [id, vec] of this.entries) {
      const sim = cosineSimilarity(query, vec);
      const distance = 1 - sim;
      if (distance <= (1 - threshold)) {
        results.push({ id, distance });
      }
    }
    return results
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  size(): number {
    return this.entries.size;
  }
}

function createTempDir(): string {
  const dir = join(tmpdir(), `memex-compiler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestProject(dir: string): void {
  const sourcesDir = join(dir, 'sources');
  mkdirSync(sourcesDir, { recursive: true });

  writeFileSync(join(sourcesDir, 'gondor.md'), `# Gondor

Gondor was a great kingdom of Men in Middle-earth.
It was founded by Elendil and Isildur after the Downfall of Numenor.
The capital of Gondor was Minas Tirith, also known as the White City.
Gondor bordered Mordor to the east.
`);

  writeFileSync(join(sourcesDir, 'mordor.md'), `# Mordor

Mordor was a dark land in the southeast of Middle-earth.
Sauron ruled Mordor from the fortress of Barad-dur.
Mount Doom, also called Orodruin, was located in Mordor.
The Black Gate guarded the entrance to Mordor.
`);

  writeFileSync(join(dir, 'memex.schema.json'), JSON.stringify({
    name: 'middle-earth-kb',
    domain: 'tolkien-lore',
    entityTypes: ['place', 'person', 'event', 'artifact'],
    sources: ['./sources'],
    compiler: {
      embedder: 'local',
      minConfidence: 0.3,
    },
    output: {
      path: 'knowledge.memex.json',
    },
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compile', () => {
  it('compiles sources into a knowledge base', async () => {
    const dir = createTempDir();
    createTestProject(dir);

    const schema: KnowledgeSchema = {
      name: 'test-kb',
      domain: 'tolkien',
      entityTypes: ['place', 'person', 'event'],
      sources: ['./sources'],
      compiler: { minConfidence: 0.3 },
    };

    const result = await compile({
      schema,
      embedder: new MockEmbedder(),
      vectorIndex: new MockVectorIndex(),
      projectDir: dir,
      dryRun: true,
    });

    const kb = result.knowledgeBase;

    // Should have extracted some claims
    expect(kb.claimCount).toBeGreaterThan(0);
    // Should have some entities
    expect(kb.entityCount).toBeGreaterThan(0);
    // Should have generated some wiki pages
    expect(kb.pageCount).toBeGreaterThan(0);
    // Should have sources
    expect(kb.sourceCount).toBe(2);
    // Should have an index
    expect(kb.index.pageCount).toBeGreaterThan(0);
    // Should have a log entry
    expect(kb.log.length).toBe(1);
    expect(kb.log[0].action).toBe('recompile');

    // Report should have content
    expect(result.report).toContain('Memex Compilation Report');
    expect(result.report).toContain('tolkien');

    rmSync(dir, { recursive: true });
  });

  it('returns empty KB when no sources found', async () => {
    const dir = createTempDir();

    const result = await compile({
      schema: {
        name: 'empty',
        domain: 'test',
        entityTypes: [],
        sources: ['./nonexistent'],
      },
      embedder: new MockEmbedder(),
      vectorIndex: new MockVectorIndex(),
      projectDir: dir,
      dryRun: true,
    });

    expect(result.knowledgeBase.claimCount).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);

    rmSync(dir, { recursive: true });
  });

  it('writes artifact to disk when not dry-run', async () => {
    const dir = createTempDir();
    createTestProject(dir);

    const schema: KnowledgeSchema = {
      name: 'test-kb',
      domain: 'tolkien',
      entityTypes: ['place', 'person', 'event'],
      sources: ['./sources'],
      compiler: { minConfidence: 0.3 },
    };

    const result = await compile({
      schema,
      embedder: new MockEmbedder(),
      vectorIndex: new MockVectorIndex(),
      projectDir: dir,
      dryRun: false,
      outputPath: 'test-output.memex.json',
    });

    expect(result.artifactPath).not.toBeNull();
    expect(result.artifactPath).toContain('test-output.memex.json');

    rmSync(dir, { recursive: true });
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it('returns 0 for zero vectors', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for different-length vectors', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('serializeKnowledgeBase / deserializeKnowledgeBase', () => {
  it('round-trips a knowledge base through serialization', async () => {
    const dir = createTempDir();
    createTestProject(dir);

    const result = await compile({
      schema: {
        name: 'round-trip-test',
        domain: 'tolkien',
        entityTypes: ['place', 'person'],
        sources: ['./sources'],
        compiler: { minConfidence: 0.3 },
      },
      embedder: new MockEmbedder(),
      vectorIndex: new MockVectorIndex(),
      projectDir: dir,
      dryRun: true,
    });

    const kb = result.knowledgeBase;
    const serialized = serializeKnowledgeBase(kb);
    const json = JSON.parse(JSON.stringify(serialized));
    const restored = deserializeKnowledgeBase(json);

    expect(restored.schema.name).toBe(kb.schema.name);
    expect(restored.claimCount).toBe(kb.claimCount);
    expect(restored.entityCount).toBe(kb.entityCount);
    expect(restored.pageCount).toBe(kb.pageCount);
    expect(restored.sourceCount).toBe(kb.sourceCount);
    expect(restored.version).toBe(kb.version);
    expect(restored.contradictions.length).toBe(kb.contradictions.length);

    // Check claim selectors round-trip (vectors as Float32Array)
    for (const [id, sel] of restored.claimSelectors) {
      expect(sel.vector).toBeInstanceOf(Float32Array);
    }

    rmSync(dir, { recursive: true });
  });
});
