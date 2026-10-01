import { describe, it, expect } from 'vitest';
import { RegexInterpreter, resolveTemplate } from './regex-interpreter.js';
import { InterpreterBudgetError } from './types.js';

describe('RegexInterpreter', () => {
  it('substitutes {{payload}} and {{context}}', async () => {
    const r = new RegexInterpreter();
    const out = await r.interpret(
      {
        template: 'When {{context}}, remember: {{payload}}',
        payload: 'use semicolons',
        context: 'writing TypeScript',
      },
      { maxOutputTokens: 200, timeoutMs: 1000 },
    );
    expect(out).toBe('When writing TypeScript, remember: use semicolons');
  });

  it('throws InterpreterBudgetError when output exceeds maxOutputTokens', async () => {
    const r = new RegexInterpreter();
    const longPayload = 'x'.repeat(2000); // ~500 tokens
    await expect(
      r.interpret(
        { template: '{{payload}}', payload: longPayload, context: 'ctx' },
        { maxOutputTokens: 20, timeoutMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(InterpreterBudgetError);
  });

  it('throws on already-aborted signal', async () => {
    const r = new RegexInterpreter();
    const ac = new AbortController();
    ac.abort();
    await expect(
      r.interpret(
        { template: '{{payload}}', payload: 'p', context: 'c' },
        { maxOutputTokens: 200, timeoutMs: 1000, signal: ac.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports tier === "regex"', () => {
    const r = new RegexInterpreter();
    expect(r.tier).toBe('regex');
  });
});

describe('resolveTemplate', () => {
  it('replaces all occurrences', () => {
    expect(resolveTemplate('{{payload}} and {{payload}}', 'X', '_')).toBe('X and X');
  });
});
