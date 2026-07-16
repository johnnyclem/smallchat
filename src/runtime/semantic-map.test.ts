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
