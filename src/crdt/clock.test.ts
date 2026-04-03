import { describe, it, expect } from 'vitest';
import {
  LamportClock,
  compareLamport,
  createVectorClock,
  tickVectorClock,
  mergeVectorClocks,
  compareVectorClocks,
} from './clock.js';

// ===========================================================================
// Feature: Lamport Clock — logical time ordering without wall clocks
// ===========================================================================

describe('LamportClock', () => {
  it('starts at zero', () => {
    const clock = new LamportClock('agent-A');
    expect(clock.current()).toBe(0);
  });

  it('increments monotonically on tick()', () => {
    const clock = new LamportClock('agent-A');
    const t1 = clock.tick();
    const t2 = clock.tick();
    const t3 = clock.tick();

    expect(t1.counter).toBe(1);
    expect(t2.counter).toBe(2);
    expect(t3.counter).toBe(3);
    expect(t1.agentId).toBe('agent-A');
  });

  it('advances past remote timestamp on receive()', () => {
    const clockA = new LamportClock('agent-A');
    clockA.tick(); // counter = 1

    const remote = { counter: 10, agentId: 'agent-B' };
    const received = clockA.receive(remote);

    // Should be max(1, 10) + 1 = 11
    expect(received.counter).toBe(11);
    expect(received.agentId).toBe('agent-A');
  });

  it('peek() returns current timestamp without incrementing', () => {
    const clock = new LamportClock('agent-A');
    clock.tick(); // 1
    clock.tick(); // 2

    const peeked = clock.peek();
    expect(peeked.counter).toBe(2);
    expect(clock.current()).toBe(2); // unchanged
  });
});

// ===========================================================================
// Feature: Lamport timestamp comparison
// ===========================================================================

describe('compareLamport', () => {
  it('orders by counter first', () => {
    const a = { counter: 1, agentId: 'Z' };
    const b = { counter: 2, agentId: 'A' };
    expect(compareLamport(a, b)).toBeLessThan(0);
    expect(compareLamport(b, a)).toBeGreaterThan(0);
  });

  it('breaks ties by agentId lexicographic order', () => {
    const a = { counter: 5, agentId: 'alpha' };
    const b = { counter: 5, agentId: 'beta' };
    expect(compareLamport(a, b)).toBeLessThan(0);
    expect(compareLamport(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 for equal timestamps', () => {
    const a = { counter: 3, agentId: 'same' };
    const b = { counter: 3, agentId: 'same' };
    expect(compareLamport(a, b)).toBe(0);
  });
});

// ===========================================================================
// Feature: Vector Clock — detecting true concurrency
// ===========================================================================

describe('Vector Clock', () => {
  it('createVectorClock initializes a single agent', () => {
    const vc = createVectorClock('agent-A', 0);
    expect(vc).toEqual({ 'agent-A': 0 });
  });

  it('tickVectorClock increments the specified agent', () => {
    let vc = createVectorClock('agent-A', 0);
    vc = tickVectorClock(vc, 'agent-A');
    expect(vc['agent-A']).toBe(1);

    vc = tickVectorClock(vc, 'agent-A');
    expect(vc['agent-A']).toBe(2);
  });

  it('tickVectorClock adds a new agent entry if missing', () => {
    const vc = tickVectorClock({}, 'agent-B');
    expect(vc['agent-B']).toBe(1);
  });

  it('mergeVectorClocks takes component-wise maximum', () => {
    const a = { 'agent-A': 3, 'agent-B': 1 };
    const b = { 'agent-A': 1, 'agent-B': 5, 'agent-C': 2 };

    const merged = mergeVectorClocks(a, b);
    expect(merged).toEqual({
      'agent-A': 3,
      'agent-B': 5,
      'agent-C': 2,
    });
  });
});

// ===========================================================================
// Feature: Vector clock causal ordering
// ===========================================================================

describe('compareVectorClocks', () => {
  it('detects equal clocks', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 1, y: 2 };
    expect(compareVectorClocks(a, b)).toBe('equal');
  });

  it('detects a before b', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 2, y: 3 };
    expect(compareVectorClocks(a, b)).toBe('before');
  });

  it('detects a after b', () => {
    const a = { x: 3, y: 4 };
    const b = { x: 2, y: 3 };
    expect(compareVectorClocks(a, b)).toBe('after');
  });

  it('detects concurrent clocks', () => {
    const a = { x: 3, y: 1 }; // x ahead
    const b = { x: 1, y: 3 }; // y ahead
    expect(compareVectorClocks(a, b)).toBe('concurrent');
  });

  it('handles missing agent entries as zero', () => {
    const a = { x: 1 };
    const b = { y: 1 };
    // a has x=1,y=0 vs b has x=0,y=1 → concurrent
    expect(compareVectorClocks(a, b)).toBe('concurrent');
  });

  it('detects before when one clock has extra agents', () => {
    const a = { x: 1 };
    const b = { x: 2, y: 1 };
    expect(compareVectorClocks(a, b)).toBe('before');
  });
});
