import { describe, it, expect } from 'vitest';
import { SemanticMap } from './semantic-map.js';

/** Build a unit vector in the given 2-D direction, padded to `dim` dims. */
function vec(x: number, y: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  v[0] = x;
  v[1] = y;
  return v;
}

describe('SemanticMap', () => {
  it('records a learned preference on first reinforce', () => {
    const map = new SemanticMap();
    const pref = map.reinforce('list my tasks', vec(1, 0), 'contexta-mcp:list_tasks', 1000);

    expect(map.size).toBe(1);
    expect(pref.reinforcements).toBe(1);
    expect(pref.selectorId).toBe('contexta-mcp:list_tasks');
    expect(pref.firstSeen).toBe(1000);
    expect(pref.lastSeen).toBe(1000);
  });

  it('strengthens (does not duplicate) an existing mapping', () => {
    const map = new SemanticMap();
    map.reinforce('list my tasks', vec(1, 0), 'contexta-mcp:list_tasks', 1000);
    const pref = map.reinforce('list my tasks', vec(1, 0), 'contexta-mcp:list_tasks', 2000);

    expect(map.size).toBe(1);
    expect(pref.reinforcements).toBe(2);
    expect(pref.lastSeen).toBe(2000);
    expect(pref.firstSeen).toBe(1000);
  });

  it('resolves the exact intent via the fast-path index', () => {
    const map = new SemanticMap();
    map.reinforce('list my tasks', vec(1, 0), 'contexta-mcp:list_tasks');

    const hit = map.lookupExact('list my tasks');
    expect(hit).not.toBeNull();
    expect(hit!.selectorId).toBe('contexta-mcp:list_tasks');
    expect(map.lookupExact('something else')).toBeNull();
  });

  it('exact index points at the most-reinforced selector for an intent', () => {
    const map = new SemanticMap();
    map.reinforce('list my tasks', vec(1, 0), 'tool_a');
    map.reinforce('list my tasks', vec(1, 0), 'tool_b');
    map.reinforce('list my tasks', vec(1, 0), 'tool_b');

    // tool_b has 2 reinforcements vs tool_a's 1
    expect(map.lookupExact('list my tasks')!.selectorId).toBe('tool_b');
  });

  it('matches a similar (not identical) intent above threshold', () => {
    const map = new SemanticMap({ similarityThreshold: 0.85 });
    map.reinforce('list my tasks', vec(1, 0), 'list_tasks');

    // Almost the same direction — high cosine similarity
    const near = map.lookupSimilar(vec(0.98, 0.2));
    expect(near).not.toBeNull();
    expect(near!.preference.selectorId).toBe('list_tasks');
    expect(near!.boost).toBeGreaterThan(0);
  });

  it('ignores an unrelated intent below threshold', () => {
    const map = new SemanticMap({ similarityThreshold: 0.85 });
    map.reinforce('list my tasks', vec(1, 0), 'list_tasks');

    // Orthogonal direction — cosine similarity 0
    expect(map.lookupSimilar(vec(0, 1))).toBeNull();
  });

  it('grows the boost with reinforcement count', () => {
    const map = new SemanticMap();
    map.reinforce('list my tasks', vec(1, 0), 'list_tasks');
    const boost1 = map.lookupSimilar(vec(1, 0))!.boost;

    map.reinforce('list my tasks', vec(1, 0), 'list_tasks');
    const boost2 = map.lookupSimilar(vec(1, 0))!.boost;

    expect(boost2).toBeGreaterThan(boost1);
  });

  it('caps the boost at maxBoost', () => {
    const map = new SemanticMap({ maxBoost: 0.2 });
    for (let i = 0; i < 50; i++) map.reinforce('list my tasks', vec(1, 0), 'list_tasks');

    const match = map.lookupSimilar(vec(1, 0))!;
    expect(match.boost).toBeLessThanOrEqual(0.2);
  });

  it('picks the closest preference when several are stored', () => {
    const map = new SemanticMap({ similarityThreshold: 0.5 });
    map.reinforce('list my tasks', vec(1, 0), 'list_tasks');
    map.reinforce('create a task', vec(0, 1), 'create_task');

    const match = map.lookupSimilar(vec(0.9, 0.1))!;
    expect(match.preference.selectorId).toBe('list_tasks');
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const map = new SemanticMap({ maxEntries: 2 });
    map.reinforce('a', vec(1, 0), 'tool_a', 1);
    map.reinforce('b', vec(0, 1), 'tool_b', 2);
    map.reinforce('c', vec(1, 1), 'tool_c', 3);

    expect(map.size).toBe(2);
    // 'a' was least-recently used and should be gone
    expect(map.lookupExact('a')).toBeNull();
    expect(map.lookupExact('b')).not.toBeNull();
    expect(map.lookupExact('c')).not.toBeNull();
  });

  it('round-trips through JSON serialization', () => {
    const map = new SemanticMap();
    map.reinforce('list my tasks', vec(1, 0), 'list_tasks', 1000);
    map.reinforce('list my tasks', vec(1, 0), 'list_tasks', 2000);
    map.reinforce('create a task', vec(0, 1), 'create_task', 1500);

    const restored = SemanticMap.fromJSON(map.toJSON());

    expect(restored.size).toBe(2);
    expect(restored.lookupExact('list my tasks')!.reinforcements).toBe(2);
    expect(restored.lookupExact('create a task')!.selectorId).toBe('create_task');
    expect(restored.lookupSimilar(vec(1, 0))!.preference.selectorId).toBe('list_tasks');
  });

  it('clear() forgets everything', () => {
    const map = new SemanticMap();
    map.reinforce('a', vec(1, 0), 'tool_a');
    map.clear();
    expect(map.size).toBe(0);
    expect(map.lookupExact('a')).toBeNull();
    expect(map.lookupSimilar(vec(1, 0))).toBeNull();
  });
});

// SC-INF-03: the map keys on the normalized full text, never canonicalize()
describe('SemanticMap identity (SC-INF-03)', () => {
  it('exact lookups match the same text up to case and whitespace, and nothing else', () => {
    const map = new SemanticMap();
    map.reinforce('delete the logs', vec(1, 0), 'ops.delete_logs');
    expect(map.lookupExact('  Delete the LOGS ')).not.toBeNull();
    expect(map.lookupExact('do not delete the logs')).toBeNull();
    expect(map.lookupExact('delete logs')).toBeNull();
  });

  it('serializes as version 2 and imports version 1 entries as similar-only', () => {
    const map = new SemanticMap();
    map.reinforce('删除所有文件', vec(1, 0), 'fs.delete_all');
    const json = map.toJSON();
    expect(json.version).toBe(2);
    expect(json.preferences[0].intentKey).toBe('删除所有文件');
    expect(SemanticMap.fromJSON(json).lookupExact('删除所有文件')?.selectorId).toBe('fs.delete_all');

    const legacy = SemanticMap.fromJSON({
      version: 1,
      preferences: [{ intentCanonical: 'delete:logs', vector: [1, 0, 0, 0], selectorId: 'ops.delete_logs', reinforcements: 2, firstSeen: 1, lastSeen: 2 }],
    });
    expect(legacy.lookupExact('delete:logs')).toBeNull();
    expect(legacy.lookupSimilar(vec(1, 0))?.preference.selectorId).toBe('ops.delete_logs');
    expect(legacy.toJSON().preferences[0].exact).toBe(false);
  });

  it('breaks similarity ties by selector id, not insertion order', () => {
    const a = new SemanticMap();
    a.reinforce('x', vec(1, 0), 'tool_b');
    a.reinforce('y', vec(1, 0), 'tool_a');
    const b = new SemanticMap();
    b.reinforce('y', vec(1, 0), 'tool_a');
    b.reinforce('x', vec(1, 0), 'tool_b');
    expect(a.lookupSimilar(vec(1, 0))!.preference.selectorId).toBe('tool_a');
    expect(b.lookupSimilar(vec(1, 0))!.preference.selectorId).toBe('tool_a');
  });
});
