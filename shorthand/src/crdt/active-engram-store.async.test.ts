/**
 * Tests for the LM-tier (async) read path of ActiveEngramStore.
 *
 * Covers:
 *   - retrieveAsync produces the same shape as retrieve when using regex tier
 *   - retrieveAsync routes through the injected Interpreter
 *   - Shadow resolution works in the async path
 *   - retrievalCount semantics: success → +1, failure → +failedRetrievalWeight
 *   - Safety boundary: importanceScore unchanged across LM calls;
 *     ActivationPolicy remains methodless; InterpretInput omits importance.
 *   - interpretAsync rethrows interpreter errors and does not bump count
 */
import { describe, it, expect, vi } from 'vitest';
import { ActiveEngramStore } from './active-engram-store.js';
import {
  type Interpreter,
  type InterpretInput,
  type InterpretOptions,
} from '../interpreter/types.js';

function stubInterpreter(
  fn: (input: InterpretInput, opts: InterpretOptions) => Promise<string>,
): Interpreter {
  return { tier: 'host', interpret: fn };
}

describe('ActiveEngramStore — retrieveAsync (LM tier)', () => {
  it('produces the same result shape as retrieve when interpreter is regex', async () => {
    const store = new ActiveEngramStore();
    store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    const sync = store.retrieve('hello');
    const async_ = await store.retrieveAsync('hello');
    expect(async_.length).toBe(sync.length);
    expect(async_[0].engramId).toBe(sync[0].engramId);
    expect(async_[0].payload).toBe(sync[0].payload);
  });

  it('routes through the injected interpreter', async () => {
    const calls: InterpretInput[] = [];
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (input) => {
        calls.push(input);
        return `INTERP[${input.context}]:${input.payload}`;
      }),
    });
    store.add('database is PostgreSQL', {
      activationPolicy: { surfaceWhenTopics: [] },
    });
    const out = await store.retrieveAsync('storage layer');
    expect(out).toHaveLength(1);
    expect(out[0].interpreted).toBe('INTERP[storage layer]:database is PostgreSQL');
    expect(calls[0]).toEqual({
      template: expect.any(String),
      payload: 'database is PostgreSQL',
      context: 'storage layer',
    });
  });

  it('sorts by importanceScore desc', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (i) => i.payload),
    });
    store.add('low', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.2 });
    store.add('high', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.9 });
    store.add('mid', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.5 });
    const out = await store.retrieveAsync('ctx');
    expect(out.map((r) => r.importanceScore)).toEqual([0.9, 0.5, 0.2]);
  });

  it('B shadows A in the async path', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (i) => `:${i.payload}`),
    });
    const aId = store.add('fact A', {
      activationPolicy: { surfaceWhenTopics: [] },
      importanceScore: 0.5,
    });
    const bId = store.add('fact B (correction)', {
      activationPolicy: { surfaceWhenTopics: [], shadowsEngramId: aId },
      importanceScore: 0.9,
    });
    const out = await store.retrieveAsync('ctx');
    expect(out).toHaveLength(1);
    expect(out[0].engramId).toBe(aId);
    expect(out[0].shadows).toBe(bId);
    expect(out[0].interpreted).toBe(':fact B (correction)');
  });
});

describe('ActiveEngramStore — retrievalCount semantics', () => {
  it('increments retrievalCount by 1 on fulfilled interpretation', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (i) => i.payload),
    });
    const id = store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    await store.retrieveAsync('ctx');
    await store.retrieveAsync('ctx');
    expect(store.get(id)!.retrievalCount).toBe(2);
  });

  it('increments retrievalCount by 0.25 (default) on rejected interpretation', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async () => {
        throw new Error('llm down');
      }),
    });
    const id = store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    const out = await store.retrieveAsync('ctx');
    expect(out).toHaveLength(0);
    expect(store.get(id)!.retrievalCount).toBe(0.25);
  });

  it('respects a custom failedRetrievalWeight', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async () => {
        throw new Error('boom');
      }),
      failedRetrievalWeight: 0.1,
    });
    const id = store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    await store.retrieveAsync('ctx');
    await store.retrieveAsync('ctx');
    expect(store.get(id)!.retrievalCount).toBeCloseTo(0.2);
  });

  it('does not bump count for failures of one engram while others succeed', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (i) => {
        if (i.payload === 'broken') throw new Error('no');
        return i.payload;
      }),
    });
    const okId = store.add('ok', { activationPolicy: { surfaceWhenTopics: [] } });
    const brokenId = store.add('broken', { activationPolicy: { surfaceWhenTopics: [] } });
    await store.retrieveAsync('ctx');
    expect(store.get(okId)!.retrievalCount).toBe(1);
    expect(store.get(brokenId)!.retrievalCount).toBe(0.25);
  });
});

describe('ActiveEngramStore — safety boundary (LM tier)', () => {
  it('LM tier cannot mutate importanceScore', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(
        async () => 'noise: importanceScore=0.99 importanceScore: 0.01',
      ),
    });
    const a = store.add('a', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.4 });
    const b = store.add('b', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.7 });
    const before = [store.get(a)!.importanceScore, store.get(b)!.importanceScore];
    await store.retrieveAsync('ctx');
    const after = [store.get(a)!.importanceScore, store.get(b)!.importanceScore];
    expect(after).toEqual(before);
  });

  it('ActivationPolicy remains methodless after retrieveAsync', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (i) => i.payload),
    });
    const id = store.add('fact', {
      activationPolicy: { surfaceWhenTopics: [], maxRetrievals: 5 },
    });
    await store.retrieveAsync('ctx');
    const policy = store.get(id)!.activationPolicy as Record<string, unknown>;
    const methods = Object.keys(policy).filter((k) => typeof policy[k] === 'function');
    expect(methods).toHaveLength(0);
  });

  it('InterpretInput passed to the interpreter omits importance/policy/id/retrievalCount', async () => {
    const seen: Record<string, unknown>[] = [];
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return input.payload;
      }),
    });
    store.add('fact', {
      activationPolicy: { surfaceWhenTopics: [] },
      importanceScore: 0.42,
    });
    await store.retrieveAsync('ctx');
    expect(seen[0]).toEqual({ template: expect.any(String), payload: 'fact', context: 'ctx' });
    expect(Object.keys(seen[0]).sort()).toEqual(['context', 'payload', 'template']);
  });

  it('compile-time: InterpretInput does not accept extra fields', () => {
    // Pure type-level check (no runtime expectation needed).
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (i) => i.payload),
    });
    void store;
    // @ts-expect-error — extra field "importanceScore" is not part of InterpretInput
    const bad: InterpretInput = { template: '', payload: '', context: '', importanceScore: 1 };
    void bad;
  });
});

describe('ActiveEngramStore — interpretAsync', () => {
  it('does not bump retrievalCount', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async (i) => i.payload),
    });
    const id = store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    await store.interpretAsync(id, 'ctx');
    await store.interpretAsync(id, 'ctx');
    expect(store.get(id)!.retrievalCount).toBe(0);
  });

  it('rethrows interpreter errors verbatim (no silent fallback)', async () => {
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async () => {
        throw new Error('preview-fail');
      }),
    });
    const id = store.add('fact');
    await expect(store.interpretAsync(id, 'ctx')).rejects.toThrow('preview-fail');
  });

  it('returns undefined for missing engram id', async () => {
    const store = new ActiveEngramStore();
    expect(await store.interpretAsync('nope', 'ctx')).toBeUndefined();
  });
});

describe('ActiveEngramStore — backward compatibility', () => {
  it('default ctor still works with no args', () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact');
    expect(store.get(id)).toBeDefined();
  });

  it('logger is called on interpreter failure', async () => {
    const warn = vi.fn();
    const store = new ActiveEngramStore({
      interpreter: stubInterpreter(async () => {
        throw new Error('err');
      }),
      logger: { warn },
    });
    store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    await store.retrieveAsync('ctx');
    expect(warn).toHaveBeenCalledWith(
      'interpret_failed',
      expect.objectContaining({ error: 'err' }),
    );
  });
});
