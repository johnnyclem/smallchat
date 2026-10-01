import { describe, it, expect, vi } from 'vitest';
import { HostInterpreter, type AnthropicLikeClient } from './host-interpreter.js';
import { InterpreterBudgetError, InterpreterUnavailableError } from './types.js';

function makeClient(
  impl: AnthropicLikeClient['messages']['create'],
): AnthropicLikeClient {
  return { messages: { create: impl } };
}

describe('HostInterpreter — happy path', () => {
  it('returns the LM text trimmed', async () => {
    const client = makeClient(async () => ({
      content: [{ text: '  the user prefers CLI tools, so lean on keyboard flows.  ' }],
    }));
    const h = new HostInterpreter({ client, model: 'm' });
    const out = await h.interpret(
      { template: '{{payload}} for {{context}}', payload: 'p', context: 'c' },
      { maxOutputTokens: 60, timeoutMs: 1000 },
    );
    expect(out).toBe('the user prefers CLI tools, so lean on keyboard flows.');
  });

  it('reports tier === "host"', () => {
    const h = new HostInterpreter({
      client: makeClient(async () => ({ content: [{ text: 'x' }] })),
      model: 'm',
    });
    expect(h.tier).toBe('host');
  });
});

describe('HostInterpreter — wire-level safety', () => {
  it('request body never contains importanceScore, id, activationPolicy, or retrievalCount', async () => {
    const create = vi.fn(async () => ({ content: [{ text: 'ok' }] }));
    const h = new HostInterpreter({ client: { messages: { create } }, model: 'm' });
    await h.interpret(
      { template: 'tmpl', payload: 'pay', context: 'ctx' },
      { maxOutputTokens: 50, timeoutMs: 500 },
    );
    const req = JSON.stringify(create.mock.calls[0][0]);
    expect(req).not.toContain('importanceScore');
    expect(req).not.toContain('activationPolicy');
    expect(req).not.toContain('retrievalCount');
    expect(req).not.toContain('"id"');
    expect(req).toContain('pay');
    expect(req).toContain('ctx');
    expect(req).toContain('tmpl');
  });

  it('passes max_tokens = maxOutputTokens', async () => {
    const create = vi.fn(async () => ({ content: [{ text: 'ok' }] }));
    const h = new HostInterpreter({ client: { messages: { create } }, model: 'm' });
    await h.interpret(
      { template: 't', payload: 'p', context: 'c' },
      { maxOutputTokens: 73, timeoutMs: 500 },
    );
    expect(create.mock.calls[0][0].max_tokens).toBe(73);
  });
});

describe('HostInterpreter — bounded contract', () => {
  it('throws InterpreterBudgetError on timeout', async () => {
    const client = makeClient(
      () => new Promise(() => undefined), // never resolves
    );
    const h = new HostInterpreter({ client, model: 'm' });
    await expect(
      h.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 25 },
      ),
    ).rejects.toMatchObject({ name: 'InterpreterBudgetError', reason: 'timeout' });
  });

  it('throws InterpreterUnavailableError on client error', async () => {
    const client = makeClient(async () => {
      throw new Error('boom');
    });
    const h = new HostInterpreter({ client, model: 'm' });
    await expect(
      h.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(InterpreterUnavailableError);
  });

  it('throws InterpreterBudgetError when output exceeds the cap', async () => {
    const client = makeClient(async () => ({
      content: [{ text: 'x'.repeat(2000) }],
    }));
    const h = new HostInterpreter({ client, model: 'm' });
    await expect(
      h.interpret(
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
    const client = makeClient(
      async (_req, opts) =>
        new Promise<never>((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const h = new HostInterpreter({ client, model: 'm' });
    const p = h.interpret(
      { template: 't', payload: 'p', context: 'c' },
      { maxOutputTokens: 50, timeoutMs: 5000, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('HostInterpreter — truncated output (SH-17)', () => {
  for (const stop_reason of ['max_tokens', 'model_context_window_exceeded'] as const) {
    it(`throws InterpreterBudgetError when stop_reason is "${stop_reason}"`, async () => {
      const client = makeClient(async () => ({
        content: [{ text: 'The user upgraded to Pro, so the rate limit does' }],
        stop_reason,
      }));
      const h = new HostInterpreter({ client, model: 'm' });
      const err = await h
        .interpret({ template: 't', payload: 'p', context: 'c' }, { maxOutputTokens: 12, timeoutMs: 1000 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InterpreterBudgetError);
      expect((err as InterpreterBudgetError).reason).toBe('output_too_long');
      expect((err as InterpreterBudgetError).meta.stopReason).toBe(stop_reason);
    });
  }

  it('treats a refusal as unavailable so withFallback routes on', async () => {
    const client = makeClient(async () => ({ content: [], stop_reason: 'refusal' }));
    const h = new HostInterpreter({ client, model: 'm' });
    await expect(
      h.interpret({ template: 't', payload: 'p', context: 'c' }, { maxOutputTokens: 12, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(InterpreterUnavailableError);
  });

  it('accepts end_turn output', async () => {
    const client = makeClient(async () => ({ content: [{ text: 'fine' }], stop_reason: 'end_turn' }));
    const h = new HostInterpreter({ client, model: 'm' });
    await expect(
      h.interpret({ template: 't', payload: 'p', context: 'c' }, { maxOutputTokens: 12, timeoutMs: 1000 }),
    ).resolves.toBe('fine');
  });
});
