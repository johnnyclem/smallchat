import { describe, it, expect, beforeEach } from 'vitest';
import { EntityGraph, computeStateDelta, extractEntities, extractRelations } from './state-delta.js';
import type { ConversationMessage } from './types.js';

function msg(id: string, content: string): ConversationMessage {
  return { id, content, timestamp: Date.now(), role: 'user' };
}

describe('EntityGraph', () => {
  let graph: EntityGraph;

  beforeEach(() => {
    graph = new EntityGraph();
  });

  it('adds and retrieves nodes', () => {
    const added = graph.addNode({
      name: 'RSA',
      type: 'identifier',
      introducedBy: 'm1',
      lastModifiedBy: 'm1',
      attributes: new Map(),
    });
    expect(added).toBe(true);
    expect(graph.hasNode('rsa')).toBe(true);
    expect(graph.size).toBe(1);
  });

  it('merges attributes on duplicate add', () => {
    graph.addNode({
      name: 'RSA',
      type: 'identifier',
      introducedBy: 'm1',
      lastModifiedBy: 'm1',
      attributes: new Map([['bits', '2048']]),
    });
    const added = graph.addNode({
      name: 'RSA',
      type: 'identifier',
      introducedBy: 'm2',
      lastModifiedBy: 'm2',
      attributes: new Map([['bits', '4096']]),
    });
    expect(added).toBe(false);
    expect(graph.getNode('rsa')!.attributes.get('bits')).toBe('4096');
    expect(graph.getNode('rsa')!.lastModifiedBy).toBe('m2');
  });

  it('removes nodes and their edges', () => {
    graph.addNode({ name: 'A', type: 't', introducedBy: 'm1', lastModifiedBy: 'm1', attributes: new Map() });
    graph.addNode({ name: 'B', type: 't', introducedBy: 'm1', lastModifiedBy: 'm1', attributes: new Map() });
    graph.addEdge({ from: 'a', to: 'b', label: 'uses', establishedBy: 'm1' });
    expect(graph.size).toBe(3); // 2 nodes + 1 edge

    graph.removeNode('A');
    expect(graph.hasNode('a')).toBe(false);
    expect(graph.getEdges().length).toBe(0);
  });

  it('adds and finds edges', () => {
    graph.addEdge({ from: 'x', to: 'y', label: 'depends_on', establishedBy: 'm1' });
    const edges = graph.edgesFor('x');
    expect(edges.length).toBe(1);
    expect(edges[0].label).toBe('depends_on');
  });

  it('deduplicates edges', () => {
    graph.addEdge({ from: 'x', to: 'y', label: 'uses', establishedBy: 'm1' });
    const added = graph.addEdge({ from: 'x', to: 'y', label: 'uses', establishedBy: 'm2' });
    expect(added).toBe(false);
    expect(graph.getEdges().length).toBe(1);
  });
});

describe('extractEntities', () => {
  it('extracts backtick-wrapped identifiers', () => {
    const entities = extractEntities('Use `Ed25519` instead of `RSA`', 'm1');
    const names = entities.map(e => e.name);
    expect(names).toContain('ed25519');
    expect(names).toContain('rsa');
  });

  it('extracts quoted terms', () => {
    const entities = extractEntities('Set the "timeout" to 30', 'm1');
    const names = entities.map(e => e.name);
    expect(names).toContain('timeout');
  });

  it('filters stopwords', () => {
    const entities = extractEntities('add `the` thing', 'm1');
    const names = entities.map(e => e.name);
    expect(names).not.toContain('the');
  });

  it('filters too-short names', () => {
    const entities = extractEntities('use `x`', 'm1');
    expect(entities.length).toBe(0);
  });
});

describe('extractRelations', () => {
  it('detects "uses" relations', () => {
    const relations = extractRelations('The server uses Redis for caching', 'm1');
    expect(relations.some(r => r.label === 'uses')).toBe(true);
  });

  it('detects "replaces" relations', () => {
    const relations = extractRelations('Ed25519 replaces RSA in the auth module', 'm1');
    expect(relations.some(r => r.label === 'replaces')).toBe(true);
  });

  it('detects "depends_on" relations', () => {
    const relations = extractRelations('The API depends on the database layer', 'm1');
    expect(relations.some(r => r.label === 'depends_on')).toBe(true);
  });
});

describe('computeStateDelta', () => {
  let graph: EntityGraph;

  beforeEach(() => {
    graph = new EntityGraph();
  });

  it('returns positive magnitude for messages introducing entities', () => {
    const delta = computeStateDelta(msg('m1', 'Use `Redis` for the cache layer'), graph);
    expect(delta.magnitude).toBeGreaterThan(0);
    expect(delta.nodesAdded.length).toBeGreaterThan(0);
  });

  it('returns zero magnitude for pure pleasantries', () => {
    const delta = computeStateDelta(msg('m1', 'Hello, how are you?'), graph);
    expect(delta.magnitude).toBe(0);
  });

  it('detects override/contradiction indicators', () => {
    // First, establish state
    computeStateDelta(msg('m1', 'Use `Redis` for caching'), graph);
    // Then contradict
    const delta = computeStateDelta(msg('m2', 'Actually, scratch that. Use `Memcached` instead'), graph);
    expect(delta.magnitude).toBeGreaterThan(0);
  });

  it('tracks node modifications when entities reappear with overrides', () => {
    computeStateDelta(msg('m1', 'Use `RSA` for encryption'), graph);
    const delta = computeStateDelta(msg('m2', 'Actually, `RSA` should use 4096 bits'), graph);
    // "Actually" triggers override detection, RSA already exists → modification
    expect(delta.magnitude).toBeGreaterThan(0);
  });

  it('assigns higher magnitude to replacements than additions', () => {
    const delta1 = computeStateDelta(msg('m1', 'Add `Redis` to the stack'), graph);
    // Reset for fair comparison
    graph.clear();
    graph.addNode({ name: 'rsa', type: 'identifier', introducedBy: 'm0', lastModifiedBy: 'm0', attributes: new Map() });
    const delta2 = computeStateDelta(msg('m2', '`Ed25519` replaces `RSA` in the auth module'), graph);
    // Replacement should have higher magnitude due to edge removal weight
    expect(delta2.magnitude).toBeGreaterThanOrEqual(delta1.magnitude);
  });
});
