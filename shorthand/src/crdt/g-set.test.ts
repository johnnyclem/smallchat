import { describe, it, expect } from 'vitest';
import { GSet, defaultMergeFn, type GSetEntry } from './g-set.js';

// ===========================================================================
// Feature: G-Set — grow-only set for topic-clustered summaries (L2)
// ===========================================================================

describe('GSet', () => {
  it('adds entries and retrieves them', () => {
    const set = new GSet<string>();
    set.add({
      value: 'Summary about auth',
      sourceAgent: 'agent-A',
      isDirectParticipant: true,
      dedupeKey: 'auth-topic',
    });

    expect(set.size).toBe(1);
    const entries = set.value();
    expect(entries[0].value).toBe('Summary about auth');
  });

  it('deduplicates by dedupeKey using merge function', () => {
    const set = new GSet<string>();

    set.add({
      value: 'Short auth summary',
      sourceAgent: 'agent-A',
      isDirectParticipant: false,
      dedupeKey: 'auth',
    });

    set.add({
      value: 'Detailed auth summary from the agent that handled it',
      sourceAgent: 'agent-B',
      isDirectParticipant: true,
      dedupeKey: 'auth',
    });

    // Should keep only one entry for 'auth', preferring the direct participant
    expect(set.size).toBe(1);
    expect(set.value()[0].isDirectParticipant).toBe(true);
    expect(set.value()[0].sourceAgent).toBe('agent-B');
  });

  it('retains entries with different dedupeKeys', () => {
    const set = new GSet<string>();

    set.add({
      value: 'Auth topic',
      sourceAgent: 'agent-A',
      isDirectParticipant: true,
      dedupeKey: 'auth',
    });

    set.add({
      value: 'Database topic',
      sourceAgent: 'agent-B',
      isDirectParticipant: true,
      dedupeKey: 'database',
    });

    expect(set.size).toBe(2);
  });

  it('getByKey retrieves by dedupeKey', () => {
    const set = new GSet<string>();
    set.add({
      value: 'content',
      sourceAgent: 'agent-A',
      isDirectParticipant: true,
      dedupeKey: 'key1',
    });

    expect(set.getByKey('key1')?.value).toBe('content');
    expect(set.getByKey('nonexistent')).toBeUndefined();
  });
});

// ===========================================================================
// Feature: G-Set default merge function — "I was there" outranks
// ===========================================================================

describe('defaultMergeFn', () => {
  it('prefers direct participant over secondhand', () => {
    const a: GSetEntry<string> = {
      value: 'heard about it',
      sourceAgent: 'agent-A',
      isDirectParticipant: false,
    };
    const b: GSetEntry<string> = {
      value: 'I was there',
      sourceAgent: 'agent-B',
      isDirectParticipant: true,
    };

    expect(defaultMergeFn(a, b)).toBe(b);
    expect(defaultMergeFn(b, a)).toBe(b);
  });

  it('prefers longer summary when both are direct participants', () => {
    const a: GSetEntry<string> = {
      value: 'short',
      sourceAgent: 'agent-A',
      isDirectParticipant: true,
    };
    const b: GSetEntry<string> = {
      value: 'this is a much longer and more detailed summary',
      sourceAgent: 'agent-B',
      isDirectParticipant: true,
    };

    expect(defaultMergeFn(a, b)).toBe(b);
  });
});

// ===========================================================================
// Feature: G-Set merge — union with deduplication
// ===========================================================================

describe('GSet merge', () => {
  it('merges non-overlapping entries from remote', () => {
    const setA = new GSet<string>();
    const setB = new GSet<string>();

    setA.add({
      value: 'topic-A',
      sourceAgent: 'agent-A',
      isDirectParticipant: true,
      dedupeKey: 'topicA',
    });

    setB.add({
      value: 'topic-B',
      sourceAgent: 'agent-B',
      isDirectParticipant: true,
      dedupeKey: 'topicB',
    });

    const changed = setA.merge(setB.serialize());
    expect(changed).toBe(true);
    expect(setA.size).toBe(2);
  });

  it('resolves duplicate dedupeKeys with merge function during merge', () => {
    const setA = new GSet<string>();
    const setB = new GSet<string>();

    setA.add({
      value: 'indirect report',
      sourceAgent: 'agent-A',
      isDirectParticipant: false,
      dedupeKey: 'auth',
    });

    setB.add({
      value: 'direct detailed observation of the auth flow',
      sourceAgent: 'agent-B',
      isDirectParticipant: true,
      dedupeKey: 'auth',
    });

    setA.merge(setB.serialize());

    expect(setA.size).toBe(1);
    const entry = setA.getByKey('auth')!;
    expect(entry.isDirectParticipant).toBe(true);
  });

  it('merge is idempotent', () => {
    const setA = new GSet<string>();
    const setB = new GSet<string>();

    setB.add({
      value: 'content',
      sourceAgent: 'agent-B',
      isDirectParticipant: true,
      dedupeKey: 'key',
    });

    const state = setB.serialize();
    setA.merge(state);
    const first = JSON.stringify(setA.serialize());

    setA.merge(state);
    const second = JSON.stringify(setA.serialize());

    expect(first).toBe(second);
  });

  it('serializes and restores via from()', () => {
    const set = new GSet<string>();
    set.add({
      value: 'hello',
      sourceAgent: 'agent-A',
      isDirectParticipant: true,
      dedupeKey: 'greeting',
    });

    const state = set.serialize();
    const restored = GSet.from(state);

    expect(restored.size).toBe(1);
    expect(restored.getByKey('greeting')?.value).toBe('hello');
  });
});
