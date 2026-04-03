import { describe, it, expect } from 'vitest';
import { RGA } from './rga.js';

// ===========================================================================
// Feature: RGA — Replicated Growable Array for message sequences (L0/L1)
// ===========================================================================

describe('RGA', () => {
  it('appends elements in order', () => {
    const rga = new RGA<string>('agent-A');
    rga.append('msg-1');
    rga.append('msg-2');
    rga.append('msg-3');

    expect(rga.value()).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(rga.length).toBe(3);
  });

  it('insertAfter places element correctly', () => {
    const rga = new RGA<string>('agent-A');
    const id1 = rga.append('first');
    rga.append('third');

    rga.insertAfter('second', id1);

    expect(rga.value()).toEqual(['first', 'second', 'third']);
  });

  it('insertAfter null inserts at head', () => {
    const rga = new RGA<string>('agent-A');
    rga.append('existing');
    rga.insertAfter('new-head', null);

    const val = rga.value();
    expect(val[0]).toBe('new-head');
  });

  it('delete marks elements as tombstones', () => {
    const rga = new RGA<string>('agent-A');
    const id1 = rga.append('keep');
    const id2 = rga.append('delete-me');
    rga.append('keep-too');

    rga.delete(id2);

    expect(rga.value()).toEqual(['keep', 'keep-too']);
    expect(rga.length).toBe(2);
  });

  it('delete returns false for nonexistent or already-deleted nodes', () => {
    const rga = new RGA<string>('agent-A');
    const id = rga.append('x');

    expect(rga.delete(id)).toBe(true);
    expect(rga.delete(id)).toBe(false); // already deleted
    expect(rga.delete({ agentId: 'ghost', counter: 999 })).toBe(false);
  });

  it('serializes including tombstones', () => {
    const rga = new RGA<string>('agent-A');
    const id = rga.append('deleted');
    rga.append('alive');
    rga.delete(id);

    const state = rga.serialize();
    expect(state.nodes.length).toBe(2); // both nodes present
    expect(state.nodes[0].deleted).toBe(true);
  });

  it('nodeIds() returns ordered visible node IDs', () => {
    const rga = new RGA<string>('agent-A');
    const id1 = rga.append('a');
    const id2 = rga.append('b');

    const ids = rga.nodeIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toEqual(id1);
    expect(ids[1]).toEqual(id2);
  });
});

// ===========================================================================
// Feature: RGA merge — interleaving concurrent message sequences
// ===========================================================================

describe('RGA merge', () => {
  it('merges non-overlapping sequences', () => {
    const rgaA = new RGA<string>('agent-A');
    const rgaB = new RGA<string>('agent-B');

    rgaA.append('A1');
    rgaA.append('A2');

    rgaB.append('B1');
    rgaB.append('B2');

    rgaA.merge(rgaB.serialize());

    const val = rgaA.value();
    // All 4 messages should be present
    expect(val).toHaveLength(4);
    expect(val).toContain('A1');
    expect(val).toContain('A2');
    expect(val).toContain('B1');
    expect(val).toContain('B2');

    // A's messages should maintain their relative order
    expect(val.indexOf('A1')).toBeLessThan(val.indexOf('A2'));
    // B's messages should maintain their relative order
    expect(val.indexOf('B1')).toBeLessThan(val.indexOf('B2'));
  });

  it('merge propagates tombstones', () => {
    const rgaA = new RGA<string>('agent-A');
    const rgaB = new RGA<string>('agent-B');

    // A creates and shares
    const id = rgaA.append('will-delete');
    rgaA.append('keep');
    rgaB.merge(rgaA.serialize());

    // A deletes
    rgaA.delete(id);
    rgaB.merge(rgaA.serialize());

    expect(rgaB.value()).toEqual(['keep']);
  });

  it('merge is idempotent', () => {
    const rgaA = new RGA<string>('agent-A');
    const rgaB = new RGA<string>('agent-B');

    rgaB.append('hello');
    const state = rgaB.serialize();

    rgaA.merge(state);
    const first = JSON.stringify(rgaA.value());

    rgaA.merge(state);
    const second = JSON.stringify(rgaA.value());

    expect(first).toBe(second);
  });

  it('restores from serialized state', () => {
    const rga = new RGA<string>('agent-A');
    rga.append('one');
    rga.append('two');
    rga.append('three');

    const state = rga.serialize();
    const restored = RGA.from<string>('agent-B', state);

    expect(restored.value()).toEqual(['one', 'two', 'three']);
  });
});
