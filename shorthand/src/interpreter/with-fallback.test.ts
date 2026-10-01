import { describe, it, expect, vi } from 'vitest';
import { withFallback } from './with-fallback.js';
import {
  InterpreterBudgetError,
  InterpreterUnavailableError,
  type Interpreter,
  type InterpreterTier,
} from './types.js';

function stub(tier: InterpreterTier, behavior: () => Promise<string>): Interpreter {
  return { tier, interpret: behavior };
}

describe('withFallback', () => {
  it('returns primary output when primary succeeds', async () => {
    const i = withFallback(
      stub('host', async () => 'host-out'),
      stub('regex', async () => 'regex-out'),
    );
    const out = await i.interpret(
      { template: 't', payload: 'p', context: 'c' },
      { maxOutputTokens: 50, timeoutMs: 1000 },
    );
    expect(out).toBe('host-out');
  });

  it('falls back on a thrown plain Error', async () => {
    const i = withFallback(
      stub('host', async () => {
        throw new Error('boom');
      }),
      stub('regex', async () => 'regex-out'),
    );
    expect(
      await i.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 1000 },
      ),
    ).toBe('regex-out');
  });

  it('falls back on InterpreterBudgetError(timeout)', async () => {
    const i = withFallback(
      stub('host', async () => {
        throw new InterpreterBudgetError('timeout', { ms: 5 });
      }),
      stub('regex', async () => 'regex-out'),
    );
    expect(
      await i.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 1000 },
      ),
    ).toBe('regex-out');
  });

  it('falls back on InterpreterBudgetError(output_too_long)', async () => {
    const i = withFallback(
      stub('host', async () => {
        throw new InterpreterBudgetError('output_too_long', { tokens: 999 });
      }),
      stub('regex', async () => 'regex-out'),
    );
    expect(
      await i.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 1000 },
      ),
    ).toBe('regex-out');
  });

  it('falls back on InterpreterUnavailableError', async () => {
    const i = withFallback(
      stub('host', async () => {
        throw new InterpreterUnavailableError('no api key');
      }),
      stub('regex', async () => 'regex-out'),
    );
    expect(
      await i.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 1000 },
      ),
    ).toBe('regex-out');
  });

  it('does NOT fall back on caller AbortError; propagates instead', async () => {
    const fallback = vi.fn(async () => 'regex-out');
    const i = withFallback(
      stub('host', async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
      { tier: 'regex', interpret: fallback },
    );
    await expect(
      i.interpret(
        { template: 't', payload: 'p', context: 'c' },
        { maxOutputTokens: 50, timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('logs the fallback event with from/to/reason', async () => {
    const logger = { warn: vi.fn() };
    const i = withFallback(
      stub('host', async () => {
        throw new InterpreterBudgetError('timeout', { ms: 5 });
      }),
      stub('regex', async () => 'regex-out'),
      { logger },
    );
    await i.interpret(
      { template: 't', payload: 'p', context: 'c' },
      { maxOutputTokens: 50, timeoutMs: 1000 },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'fallback',
      expect.objectContaining({ from: 'host', to: 'regex' }),
    );
  });

  it('reports primary tier', () => {
    const i = withFallback(
      stub('host', async () => 'x'),
      stub('regex', async () => 'y'),
    );
    expect(i.tier).toBe('host');
  });
});
