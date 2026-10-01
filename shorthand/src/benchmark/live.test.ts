/**
 * Live benchmark wiring (`npm run benchmark:live`), against a stub client.
 *
 * SH-19: the live run used a retired default model, fell back to the regex
 * tier silently while the report said 'host', echoed the injected text when
 * the answerer failed, and scored 0 when the judge failed. A live run now
 * fails loudly instead.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIVE_MODEL,
  createAnthropicAnswerer,
  createLiveBenchmark,
} from './live.js';
import { STARTER_FIXTURES } from './fixtures.js';
import type {
  AnthropicLikeClient,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
} from '../interpreter/host-interpreter.js';

type Role = 'interpret' | 'answer' | 'judge';

function roleOf(req: AnthropicMessageRequest): Role {
  if (/interpreter for an active memory/.test(req.system)) return 'interpret';
  if (/grader/i.test(req.system)) return 'judge';
  return 'answer';
}

function stubClient(
  handlers: Partial<Record<Role, (req: AnthropicMessageRequest) => Promise<AnthropicMessageResponse>>>,
): AnthropicLikeClient & { requests: AnthropicMessageRequest[] } {
  const requests: AnthropicMessageRequest[] = [];
  return {
    requests,
    messages: {
      create: async (req) => {
        requests.push(req);
        const handler = handlers[roleOf(req)];
        if (!handler) throw new Error(`no handler for ${roleOf(req)}`);
        return handler(req);
      },
    },
  };
}

const text = (t: string) => async () => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

describe('live benchmark wiring', () => {
  it('does not default to a retired model', () => {
    expect(['claude-3-5-haiku-latest', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307']).not.toContain(
      DEFAULT_LIVE_MODEL,
    );
    expect(DEFAULT_LIVE_MODEL).toBe('claude-haiku-4-5');
  });

  it('reports a host outage instead of scoring a silent regex fallback as host (SH-19)', async () => {
    const client = stubClient({
      interpret: async () => {
        throw new Error('404 model not found');
      },
      answer: text('An answer.'),
      judge: text('{"score": 0.5, "reason": "partial"}'),
    });
    const report = await createLiveBenchmark({ client, model: 'm' }).run(STARTER_FIXTURES);
    expect(report.interpreterTier).toBe('host');
    expect(report.aggregate.interpretFailures).toBe(STARTER_FIXTURES.length);
    expect(report.results.every((r) => /404 model not found/.test(r.interpretError ?? ''))).toBe(true);
    expect(report.gate.passed).toBe(false);
    // No regex substitution reached an arm: the failed arm injected the raw payload.
    for (const r of report.results) expect(r.interp.injected).toBe(r.fixture.payload);
  });

  it('gives the answerer and the judge their own prompts and the configured model', async () => {
    const client = stubClient({
      interpret: text('Restated for now.'),
      answer: text('An answer.'),
      judge: text('{"score": 0.5, "reason": "partial"}'),
    });
    const report = await createLiveBenchmark({ client, model: 'the-model' }).run(STARTER_FIXTURES.slice(0, 1));
    expect(report.answerer).toBe('custom');
    expect(report.judge).toBe('lm');
    const roles = client.requests.map(roleOf);
    expect(roles.filter((r) => r === 'interpret')).toHaveLength(1);
    expect(roles.filter((r) => r === 'answer')).toHaveLength(2);
    expect(roles.filter((r) => r === 'judge')).toHaveLength(2);
    expect(client.requests.every((r) => r.model === 'the-model')).toBe(true);
    const answerReq = client.requests.find((r) => roleOf(r) === 'answer')!;
    expect(answerReq.messages[0].content).toContain(STARTER_FIXTURES[0].task.question);
  });

  it('fails the run when the answerer fails instead of echoing the injected text (SH-19)', async () => {
    const client = stubClient({
      interpret: text('Restated for now.'),
      answer: async () => {
        throw new Error('529 overloaded');
      },
      judge: text('{"score": 0.5, "reason": "partial"}'),
    });
    await expect(createLiveBenchmark({ client, model: 'm' }).run(STARTER_FIXTURES)).rejects.toThrow(
      /529 overloaded/,
    );
  });

  it('the answerer refuses truncated output', async () => {
    const answerer = createAnthropicAnswerer({
      client: stubClient({ answer: async () => ({ content: [{ text: 'Yes, because' }], stop_reason: 'max_tokens' }) }),
      model: 'm',
    });
    await expect(answerer({ question: 'q', injected: 'i', readContext: 'c' })).rejects.toThrow(/max_tokens/);
  });
});
