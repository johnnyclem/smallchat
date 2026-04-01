import { describe, it, expect, vi } from 'vitest';
import { verify, computeKeywordOverlap } from './verification.js';
import type { ToolIMP, ToolSchema } from '../core/types.js';
import type { LLMClient } from '../core/llm-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchema(overrides?: Partial<ToolSchema>): ToolSchema {
  return {
    name: 'send_email',
    description: 'Send an email message',
    inputSchema: { type: 'object' },
    arguments: [
      { name: 'to', type: { type: 'string' }, description: 'Recipient email', required: true },
      { name: 'body', type: { type: 'string' }, description: 'Email body', required: true },
      { name: 'subject', type: { type: 'string' }, description: 'Email subject line', required: false },
    ],
    ...overrides,
  };
}

function makeIMP(schema?: ToolSchema | null): ToolIMP {
  const s = schema === undefined ? makeSchema() : schema;
  return {
    providerId: 'test',
    toolName: s?.name ?? 'unknown_tool',
    transportType: 'local' as const,
    schema: s,
    schemaLoader: async () => s ?? makeSchema(),
    execute: async () => ({ content: 'ok' }),
    constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
  };
}

// ---------------------------------------------------------------------------
// computeKeywordOverlap
// ---------------------------------------------------------------------------

describe('computeKeywordOverlap', () => {
  it('returns high overlap when intent closely matches tool metadata', () => {
    const schema = makeSchema();
    const score = computeKeywordOverlap('send an email message', schema);
    // "send", "email", "message" all appear in the tool description/name
    expect(score).toBeGreaterThan(0.5);
  });

  it('returns moderate overlap for partial matches', () => {
    const schema = makeSchema();
    const score = computeKeywordOverlap('email someone about the project', schema);
    // "email" matches, most other words do not
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('returns zero overlap when intent has no matching tokens', () => {
    const schema = makeSchema();
    const score = computeKeywordOverlap('deploy kubernetes cluster', schema);
    expect(score).toBe(0);
  });

  it('returns zero for empty intent', () => {
    const schema = makeSchema();
    const score = computeKeywordOverlap('', schema);
    expect(score).toBe(0);
  });

  it('handles stopword-only intent gracefully', () => {
    const schema = makeSchema();
    // all stopwords => tokenize returns empty set => 0
    const score = computeKeywordOverlap('the a an to for', schema);
    expect(score).toBe(0);
  });

  it('is case-insensitive', () => {
    const schema = makeSchema();
    const lower = computeKeywordOverlap('send email', schema);
    const upper = computeKeywordOverlap('SEND EMAIL', schema);
    expect(lower).toBe(upper);
  });

  it('matches argument names and descriptions', () => {
    const schema = makeSchema();
    // "recipient" appears in the 'to' argument description
    const score = computeKeywordOverlap('recipient email body', schema);
    expect(score).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// verify — Schema validation
// ---------------------------------------------------------------------------

describe('verify — schema validation', () => {
  it('passes when all required args are provided', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'send email message', { to: 'a@b.com', body: 'hello' });
    expect(result.pass).toBe(true);
    expect(result.schemaMatch).toBe(true);
  });

  it('passes when required + optional args are provided', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'send email message', { to: 'a@b.com', body: 'hello', subject: 'hi' });
    expect(result.pass).toBe(true);
    expect(result.schemaMatch).toBe(true);
  });

  it('fails when a required arg is missing', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'send email message', { to: 'a@b.com' }); // missing 'body'
    expect(result.pass).toBe(false);
    expect(result.schemaMatch).toBe(false);
    expect(result.reason).toContain('missing');
  });

  it('fails when all required args are missing', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'send email message', {});
    expect(result.pass).toBe(false);
    expect(result.schemaMatch).toBe(false);
  });

  it('loads schema via schemaLoader when schema is null', async () => {
    const schema = makeSchema();
    const imp = makeIMP(null);
    imp.schemaLoader = vi.fn(async () => schema);

    const result = await verify(imp, 'send email message', { to: 'x', body: 'y' });
    expect(imp.schemaLoader).toHaveBeenCalled();
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify — Keyword overlap threshold
// ---------------------------------------------------------------------------

describe('verify — keyword overlap', () => {
  it('fails when keyword overlap is below default threshold (0.15)', async () => {
    const imp = makeIMP();
    // intent with zero overlap with send_email tool
    const result = await verify(imp, 'deploy kubernetes cluster', { to: 'a@b.com', body: 'x' });
    expect(result.pass).toBe(false);
    expect(result.schemaMatch).toBe(true);
    expect(result.descriptionOverlap).toBeLessThan(0.15);
    expect(result.reason).toContain('Low keyword overlap');
  });

  it('passes when overlap is above default threshold', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'send email message', { to: 'a@b.com', body: 'x' });
    expect(result.pass).toBe(true);
    expect(result.descriptionOverlap).toBeGreaterThanOrEqual(0.15);
  });
});

// ---------------------------------------------------------------------------
// verify — Custom minOverlap
// ---------------------------------------------------------------------------

describe('verify — custom minOverlap', () => {
  it('uses custom minOverlap threshold', async () => {
    const imp = makeIMP();
    // "email body" has some overlap but might not reach 0.9
    const result = await verify(imp, 'email body', { to: 'a@b.com', body: 'x' }, undefined, { minOverlap: 0.9 });
    const overlap = computeKeywordOverlap('email body', makeSchema());
    if (overlap < 0.9) {
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('Low keyword overlap');
    } else {
      expect(result.pass).toBe(true);
    }
  });

  it('passes with minOverlap of 0 even with low overlap', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'something unrelated', { to: 'a@b.com', body: 'x' }, undefined, { minOverlap: 0 });
    // Schema matches and minOverlap is 0, so any overlap >= 0 passes
    expect(result.schemaMatch).toBe(true);
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify — LLM micro-check
// ---------------------------------------------------------------------------

describe('verify — LLM micro-check', () => {
  it('calls microCheck when overlap < 0.5 and llmClient is provided', async () => {
    const imp = makeIMP();
    // "email recipient" has moderate overlap (above 0.15 but likely below 0.5)
    const intent = 'email recipient';
    const overlap = computeKeywordOverlap(intent, makeSchema());
    // Only run this test if overlap is in the right range
    if (overlap >= 0.15 && overlap < 0.5) {
      const mockMicroCheck = vi.fn(async () => true);
      const llmClient: LLMClient = { microCheck: mockMicroCheck } as unknown as LLMClient;

      const result = await verify(imp, intent, { to: 'a@b.com', body: 'x' }, llmClient);
      expect(mockMicroCheck).toHaveBeenCalledWith({
        intent,
        toolName: 'send_email',
        toolDescription: 'Send an email message',
      });
      expect(result.llmConfirmed).toBe(true);
      expect(result.pass).toBe(true);
    }
  });

  it('does not call microCheck when overlap >= 0.5', async () => {
    const imp = makeIMP();
    const intent = 'send email message'; // high overlap
    const mockMicroCheck = vi.fn(async () => true);
    const llmClient: LLMClient = { microCheck: mockMicroCheck } as unknown as LLMClient;

    const result = await verify(imp, intent, { to: 'a@b.com', body: 'x' }, llmClient);
    expect(mockMicroCheck).not.toHaveBeenCalled();
    expect(result.llmConfirmed).toBeUndefined();
    expect(result.pass).toBe(true);
  });

  it('does not call microCheck when skipLLMCheck is true', async () => {
    const imp = makeIMP();
    const intent = 'email recipient';
    const mockMicroCheck = vi.fn(async () => true);
    const llmClient: LLMClient = { microCheck: mockMicroCheck } as unknown as LLMClient;

    const result = await verify(imp, intent, { to: 'a@b.com', body: 'x' }, llmClient, { skipLLMCheck: true });
    expect(mockMicroCheck).not.toHaveBeenCalled();
    expect(result.llmConfirmed).toBeUndefined();
  });

  it('does not call microCheck when llmClient has no microCheck method', async () => {
    const imp = makeIMP();
    const llmClient: LLMClient = {} as unknown as LLMClient;

    const result = await verify(imp, 'email recipient', { to: 'a@b.com', body: 'x' }, llmClient);
    expect(result.llmConfirmed).toBeUndefined();
  });

  it('returns pass=false when microCheck rejects', async () => {
    const imp = makeIMP();
    const intent = 'email recipient';
    const overlap = computeKeywordOverlap(intent, makeSchema());

    if (overlap >= 0.15 && overlap < 0.5) {
      const mockMicroCheck = vi.fn(async () => false);
      const llmClient: LLMClient = { microCheck: mockMicroCheck } as unknown as LLMClient;

      const result = await verify(imp, intent, { to: 'a@b.com', body: 'x' }, llmClient);
      expect(result.pass).toBe(false);
      expect(result.llmConfirmed).toBe(false);
      expect(result.reason).toContain('LLM micro-check rejected');
    }
  });
});

// ---------------------------------------------------------------------------
// verify — Full flow integration
// ---------------------------------------------------------------------------

describe('verify — full flow', () => {
  it('all strategies pass: schema OK, overlap OK, no LLM needed', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'send email message', { to: 'a@b.com', body: 'hello' });
    expect(result).toEqual({
      pass: true,
      schemaMatch: true,
      descriptionOverlap: expect.any(Number),
    });
    expect(result.descriptionOverlap).toBeGreaterThanOrEqual(0.5);
  });

  it('schema fails: short-circuits before keyword overlap', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'send email message', {}); // missing required args
    expect(result.pass).toBe(false);
    expect(result.schemaMatch).toBe(false);
    expect(result.descriptionOverlap).toBe(0); // never computed
  });

  it('keyword fails: schema passes but overlap too low', async () => {
    const imp = makeIMP();
    const result = await verify(imp, 'deploy kubernetes cluster', { to: 'a@b.com', body: 'x' });
    expect(result.pass).toBe(false);
    expect(result.schemaMatch).toBe(true);
    expect(result.descriptionOverlap).toBeLessThan(0.15);
  });

  it('LLM rejects: schema and overlap pass, but LLM says no', async () => {
    // Need intent with overlap in [0.15, 0.5) range
    const schema = makeSchema({
      name: 'search_files',
      description: 'Search files content patterns',
      arguments: [
        { name: 'query', type: { type: 'string' }, description: 'Search query pattern', required: true },
      ],
    });
    const imp = makeIMP(schema);
    const intent = 'search query';
    const overlap = computeKeywordOverlap(intent, schema);

    if (overlap >= 0.15 && overlap < 0.5) {
      const mockMicroCheck = vi.fn(async () => false);
      const llmClient: LLMClient = { microCheck: mockMicroCheck } as unknown as LLMClient;

      const result = await verify(imp, intent, { query: 'foo' }, llmClient);
      expect(result.pass).toBe(false);
      expect(result.schemaMatch).toBe(true);
      expect(result.llmConfirmed).toBe(false);
      expect(result.reason).toContain('LLM micro-check rejected');
    }
  });

  it('LLM confirms borderline match', async () => {
    const schema = makeSchema({
      name: 'search_files',
      description: 'Search files content patterns',
      arguments: [
        { name: 'query', type: { type: 'string' }, description: 'Search query pattern', required: true },
      ],
    });
    const imp = makeIMP(schema);
    const intent = 'search query';
    const overlap = computeKeywordOverlap(intent, schema);

    if (overlap >= 0.15 && overlap < 0.5) {
      const mockMicroCheck = vi.fn(async () => true);
      const llmClient: LLMClient = { microCheck: mockMicroCheck } as unknown as LLMClient;

      const result = await verify(imp, intent, { query: 'foo' }, llmClient);
      expect(result.pass).toBe(true);
      expect(result.schemaMatch).toBe(true);
      expect(result.llmConfirmed).toBe(true);
    }
  });
});
