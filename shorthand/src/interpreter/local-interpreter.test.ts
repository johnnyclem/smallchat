import { describe, it, expect, vi } from 'vitest';
import { LocalInterpreter } from './local-interpreter.js';
import { InterpreterBudgetError, InterpreterUnavailableError } from './types.js';

type FetchInit = { method?: string; body?: string; signal?: AbortSignal };
type FetchLike = (url: string, init?: FetchInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

function makeOkFetch(response: string): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ response }),
  });
}

describe('LocalInterpreter — happy path', () => {
  it('POSTs the right body and returns the trimmed response', async () => {
    const fetch = vi.fn(makeOkFetch('the answer\n\n')) as unknown as FetchLike;
    const l = new LocalInterpreter({ model: 'llama3', fetch });
    const out = await l.interpret(
      { template: 't', payload: 'p', context: 'c' },
      { maxOutputTokens: 50, timeoutMs: 1000 },
    );
    expect(out).toBe('the answer');
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('http://localhost:11434/api/generate');
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('llama3');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(50);
  });
});

describe('LocalInterpreter — bounded contract', () => {
  it('treats network refusal as InterpreterUnavailableError', async () => {
    const fetch: FetchLike = async () => {
      const e = new Error('connect ECONNREFUSED');
      throw e;
    };
    const l = new LocalInterpreter({ model: 'llama3', fetch });
    await expect(
      l.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(InterpreterUnavailableError);
  });

  it('treats non-2xx as InterpreterUnavailableError', async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 500,
      text: async () => 'oops',
    });
    const l = new LocalInterpreter({ model: 'llama3', fetch });
    await expect(
      l.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(InterpreterUnavailableError);
  });

  it('throws InterpreterBudgetError on timeout', async () => {
    const fetch: FetchLike = () => new Promise(() => undefined);
    const l = new LocalInterpreter({ model: 'llama3', fetch });
    await expect(
      l.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 25 },
      ),
    ).rejects.toMatchObject({ name: 'InterpreterBudgetError', reason: 'timeout' });
  });

  it('throws InterpreterBudgetError when output exceeds the cap', async () => {
    const l = new LocalInterpreter({
      model: 'llama3',
      fetch: makeOkFetch('x'.repeat(2000)),
    });
    await expect(
      l.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 20, timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({
      name: 'InterpreterBudgetError',
      reason: 'output_too_long',
    });
    void InterpreterBudgetError;
  });

  it('propagates AbortError when caller signal aborts', async () => {
    const ac = new AbortController();
    const fetch: FetchLike = (_, init) =>
      new Promise<never>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const l = new LocalInterpreter({ model: 'llama3', fetch });
    const p = l.interpret(
      { template: 't', payload: 'p', context: 'c' },
      { maxOutputTokens: 50, timeoutMs: 5000, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('LocalInterpreter — truncated output (SH-17)', () => {
  it('throws InterpreterBudgetError when Ollama reports done_reason "length"', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: 'the rate limit does', done: true, done_reason: 'length' }),
    });
    const l = new LocalInterpreter({ model: 'llama3', fetch });
    const err = await l
      .interpret({ template: 't', payload: 'p', context: 'c' }, { maxOutputTokens: 5, timeoutMs: 1000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InterpreterBudgetError);
    expect((err as InterpreterBudgetError).meta.doneReason).toBe('length');
  });

  it('accepts done_reason "stop"', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: 'ok', done: true, done_reason: 'stop' }),
    });
    const l = new LocalInterpreter({ model: 'llama3', fetch });
    await expect(
      l.interpret({ template: 't', payload: 'p', context: 'c' }, { maxOutputTokens: 5, timeoutMs: 1000 }),
    ).resolves.toBe('ok');
  });
});

describe('LocalInterpreter — runtime floor', () => {
  it('names the suite Node floor (22) when no fetch is available', () => {
    const g = globalThis as { fetch?: unknown };
    const saved = g.fetch;
    g.fetch = undefined;
    try {
      expect(() => new LocalInterpreter({ model: 'llama3' })).toThrow(/Node ≥22/);
    } finally {
      g.fetch = saved;
    }
  });
});
