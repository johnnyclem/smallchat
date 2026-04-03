import { describe, it, expect } from 'vitest';
import { LWWRegister } from './lww-register.js';

// ===========================================================================
// Feature: LWW-Register — Last Writer Wins for core invariants (L4)
// ===========================================================================

describe('LWWRegister', () => {
  it('stores and retrieves key-value pairs', () => {
    const reg = new LWWRegister<string>('agent-A');
    reg.set('database', 'PostgreSQL');
    reg.set('framework', 'Next.js');

    expect(reg.get('database')).toBe('PostgreSQL');
    expect(reg.get('framework')).toBe('Next.js');
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('overwrites values with later timestamps', () => {
    const reg = new LWWRegister<string>('agent-A');
    reg.set('database', 'MySQL');
    reg.set('database', 'PostgreSQL');

    expect(reg.get('database')).toBe('PostgreSQL');
  });

  it('tracks existence with has()', () => {
    const reg = new LWWRegister<string>('agent-A');
    expect(reg.has('key')).toBe(false);
    reg.set('key', 'val');
    expect(reg.has('key')).toBe(true);
  });

  it('returns all live values via value()', () => {
    const reg = new LWWRegister<string>('agent-A');
    reg.set('a', '1');
    reg.set('b', '2');

    const vals = reg.value();
    expect(vals.get('a')).toBe('1');
    expect(vals.get('b')).toBe('2');
    expect(vals.size).toBe(2);
  });

  it('serializes and round-trips', () => {
    const reg = new LWWRegister<string>('agent-A');
    reg.set('x', 'hello');
    reg.set('y', 'world');

    const serialized = reg.serialize();
    const reg2 = LWWRegister.from<string>('agent-B', serialized);

    expect(reg2.get('x')).toBe('hello');
    expect(reg2.get('y')).toBe('world');
  });
});

// ===========================================================================
// Feature: LWW-Register merge — concurrent writes resolved by timestamp
// ===========================================================================

describe('LWWRegister merge', () => {
  it('remote value wins when it has a higher timestamp', () => {
    const regA = new LWWRegister<string>('agent-A');
    const regB = new LWWRegister<string>('agent-B');

    regA.set('database', 'MySQL'); // ts=1

    // B sets the same key but later (B's clock starts at 0 too,
    // but we do multiple ticks to ensure higher counter)
    regB.set('_warmup1', 'x');
    regB.set('_warmup2', 'x');
    regB.set('database', 'PostgreSQL'); // ts=3

    const changed = regA.merge(regB.serialize());
    expect(changed).toBe(true);
    expect(regA.get('database')).toBe('PostgreSQL');
  });

  it('local value preserved when it has a higher timestamp', () => {
    const regA = new LWWRegister<string>('agent-A');
    const regB = new LWWRegister<string>('agent-B');

    // A does many operations first
    regA.set('_w1', 'x');
    regA.set('_w2', 'x');
    regA.set('_w3', 'x');
    regA.set('database', 'PostgreSQL'); // ts=4

    regB.set('database', 'MySQL'); // ts=1

    const changed = regA.merge(regB.serialize());
    // B's _warmup keys would be new, so changed is true
    // But the database key should remain PostgreSQL
    expect(regA.get('database')).toBe('PostgreSQL');
  });

  it('merges non-overlapping keys from both sides', () => {
    const regA = new LWWRegister<string>('agent-A');
    const regB = new LWWRegister<string>('agent-B');

    regA.set('frontend', 'React');
    regB.set('backend', 'Express');

    regA.merge(regB.serialize());

    expect(regA.get('frontend')).toBe('React');
    expect(regA.get('backend')).toBe('Express');
  });

  it('merge is idempotent', () => {
    const regA = new LWWRegister<string>('agent-A');
    const regB = new LWWRegister<string>('agent-B');

    regB.set('key', 'value');
    const state = regB.serialize();

    regA.merge(state);
    const firstResult = regA.serialize();

    regA.merge(state); // merge again
    const secondResult = regA.serialize();

    expect(JSON.stringify(firstResult)).toBe(JSON.stringify(secondResult));
  });

  it('merge is commutative — order does not matter', () => {
    const regA = new LWWRegister<string>('agent-A');
    const regB = new LWWRegister<string>('agent-B');
    const regC = new LWWRegister<string>('agent-C');

    regA.set('key', 'from-A');
    regB.set('key', 'from-B');

    // Merge A into C, then B into C
    const stateA = regA.serialize();
    const stateB = regB.serialize();

    const order1 = new LWWRegister<string>('observer-1');
    order1.merge(stateA);
    order1.merge(stateB);

    const order2 = new LWWRegister<string>('observer-2');
    order2.merge(stateB);
    order2.merge(stateA);

    // Both orderings should produce the same result
    expect(order1.get('key')).toBe(order2.get('key'));
  });
});
