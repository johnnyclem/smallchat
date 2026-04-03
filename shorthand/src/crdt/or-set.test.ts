import { describe, it, expect } from 'vitest';
import { ORSet } from './or-set.js';

// ===========================================================================
// Feature: OR-Set — add-wins set for knowledge graph nodes (L3)
// ===========================================================================

describe('ORSet', () => {
  it('adds and checks membership', () => {
    const set = new ORSet<string>('agent-A');
    set.add('node-1');
    set.add('node-2');

    expect(set.has('node-1')).toBe(true);
    expect(set.has('node-2')).toBe(true);
    expect(set.has('node-3')).toBe(false);
  });

  it('removes elements', () => {
    const set = new ORSet<string>('agent-A');
    set.add('node-1');
    set.add('node-2');

    set.remove('node-1');

    expect(set.has('node-1')).toBe(false);
    expect(set.has('node-2')).toBe(true);
  });

  it('reports correct size', () => {
    const set = new ORSet<string>('agent-A');
    expect(set.size).toBe(0);

    set.add('a');
    set.add('b');
    expect(set.size).toBe(2);

    set.remove('a');
    expect(set.size).toBe(1);
  });

  it('value() returns the current element set', () => {
    const set = new ORSet<string>('agent-A');
    set.add('x');
    set.add('y');
    set.add('z');
    set.remove('y');

    const val = set.value();
    expect(val.has('x')).toBe(true);
    expect(val.has('z')).toBe(true);
    expect(val.has('y')).toBe(false);
    expect(val.size).toBe(2);
  });

  it('works with complex objects', () => {
    const set = new ORSet<{ id: string; name: string }>('agent-A');
    set.add({ id: '1', name: 'UserService' });
    set.add({ id: '2', name: 'AuthService' });

    expect(set.size).toBe(2);
  });

  it('serializes and round-trips', () => {
    const set = new ORSet<string>('agent-A');
    set.add('alpha');
    set.add('beta');

    const state = set.serialize();
    const restored = ORSet.from<string>('agent-B', state);

    expect(restored.has('alpha')).toBe(true);
    expect(restored.has('beta')).toBe(true);
    expect(restored.size).toBe(2);
  });
});

// ===========================================================================
// Feature: OR-Set merge — add wins over concurrent remove
// ===========================================================================

describe('ORSet merge', () => {
  it('add-wins: concurrent add and remove keeps the element', () => {
    const setA = new ORSet<string>('agent-A');
    const setB = new ORSet<string>('agent-B');

    // Both start with "entity-X"
    setA.add('entity-X');
    setB.merge(setA.serialize());

    // A removes, B concurrently adds again
    setA.remove('entity-X');
    setB.add('entity-X'); // new unique tag

    // Merge B into A — the new tag from B survives
    setA.merge(setB.serialize());

    expect(setA.has('entity-X')).toBe(true);
  });

  it('merges non-overlapping elements', () => {
    const setA = new ORSet<string>('agent-A');
    const setB = new ORSet<string>('agent-B');

    setA.add('from-A');
    setB.add('from-B');

    setA.merge(setB.serialize());

    expect(setA.has('from-A')).toBe(true);
    expect(setA.has('from-B')).toBe(true);
  });

  it('merge is idempotent', () => {
    const setA = new ORSet<string>('agent-A');
    const setB = new ORSet<string>('agent-B');

    setB.add('item');
    const state = setB.serialize();

    setA.merge(state);
    const first = JSON.stringify(setA.serialize());

    setA.merge(state);
    const second = JSON.stringify(setA.serialize());

    expect(first).toBe(second);
  });

  it('merge is commutative', () => {
    const setA = new ORSet<string>('agent-A');
    const setB = new ORSet<string>('agent-B');

    setA.add('alpha');
    setA.add('beta');
    setB.add('gamma');
    setB.add('delta');

    const stateA = setA.serialize();
    const stateB = setB.serialize();

    // Order 1: merge A then B
    const obs1 = new ORSet<string>('obs-1');
    obs1.merge(stateA);
    obs1.merge(stateB);

    // Order 2: merge B then A
    const obs2 = new ORSet<string>('obs-2');
    obs2.merge(stateB);
    obs2.merge(stateA);

    const val1 = obs1.value();
    const val2 = obs2.value();

    expect(val1.size).toBe(val2.size);
    for (const elem of val1) {
      expect(val2.has(elem)).toBe(true);
    }
  });
});
