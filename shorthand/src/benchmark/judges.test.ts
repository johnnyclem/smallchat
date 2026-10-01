import { describe, it, expect } from 'vitest';
import { KeywordJudge, LMJudge } from './judges.js';
import { ModelCallError } from './model-call.js';
import type {
  AnthropicLikeClient,
  AnthropicMessageResponse,
} from '../interpreter/host-interpreter.js';

describe('KeywordJudge', () => {
  const judge = new KeywordJudge();

  it('returns ~1.0 for identical content', async () => {
    const score = await judge.score({
      answer: 'user prefers CLI tools',
      expectedAnswer: 'user prefers CLI tools',
      readContext: 'irrelevant',
    });
    expect(score).toBeGreaterThan(0.9);
  });

  it('returns 0 for fully disjoint content', async () => {
    const score = await judge.score({
      answer: 'apples bananas oranges',
      expectedAnswer: 'rockets satellites probes',
      readContext: 'irrelevant',
    });
    expect(score).toBe(0);
  });

  it('substring fallback wins for short verbatim expected answers', async () => {
    const score = await judge.score({
      answer: 'the fingerprint is SHA256:9f2b3c5d7e1a in the rotation log',
      expectedAnswer: 'SHA256:9f2b3c5d7e1a',
      readContext: 'irrelevant',
    });
    expect(score).toBe(1);
  });

  it('returns 0 when no expectedAnswer or rubric is given', async () => {
    const score = await judge.score({ answer: 'x', readContext: 'c' });
    expect(score).toBe(0);
  });
});

type Request = Parameters<AnthropicLikeClient['messages']['create']>[0];

function stubClient(
  respond: (req: Request) => Promise<AnthropicMessageResponse>,
): AnthropicLikeClient & { requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    messages: {
      create: async (req) => {
        requests.push(req);
        return respond(req);
      },
    },
  };
}

const reply = (text: string, stop_reason = 'end_turn') => async () => ({
  content: [{ type: 'text', text }],
  stop_reason,
});

describe('LMJudge', () => {
  it('parses a JSON score response', async () => {
    const j = new LMJudge({ client: stubClient(reply('{"score": 0.7, "reason": "ok"}')), model: 'm' });
    const score = await j.score({ answer: 'a', readContext: 'c', rubric: 'r' });
    expect(score).toBe(0.7);
  });

  it('makes its own grading call with structured output, not the interpreter prompt (SH-19)', async () => {
    const client = stubClient(reply('{"score": 1, "reason": "ok"}'));
    await new LMJudge({ client, model: 'judge-model' }).score({
      answer: 'the answer',
      expectedAnswer: 'expected',
      readContext: 'ctx',
    });
    const req = client.requests[0];
    expect(req.model).toBe('judge-model');
    expect(req.system).toMatch(/grader/i);
    expect(req.system).not.toMatch(/plain prose sentence/);
    expect(req.output_config?.format.type).toBe('json_schema');
    expect(req.output_config?.format.schema).toMatchObject({
      type: 'object',
      required: ['score', 'reason'],
      additionalProperties: false,
    });
    expect(req.messages[0].content).toContain('the answer');
    expect(req.messages[0].content).toContain('expected');
  });

  it('throws on a score outside [0, 1] instead of clamping it', async () => {
    const j = new LMJudge({ client: stubClient(reply('{"score": 1.5, "reason": "x"}')), model: 'm' });
    await expect(j.score({ answer: 'a', readContext: 'c' })).rejects.toBeInstanceOf(ModelCallError);
  });

  it('throws on malformed JSON instead of scoring 0 (SH-19)', async () => {
    const j = new LMJudge({ client: stubClient(reply('not json at all')), model: 'm' });
    await expect(j.score({ answer: 'a', readContext: 'c' })).rejects.toThrow(/judge/);
  });

  it('throws when the call fails instead of scoring 0 (SH-19)', async () => {
    const j = new LMJudge({
      client: stubClient(async () => {
        throw new Error('404 model not found');
      }),
      model: 'retired',
    });
    await expect(j.score({ answer: 'a', readContext: 'c' })).rejects.toThrow(/404 model not found/);
  });

  it('throws on a truncated or refused grade', async () => {
    const cut = new LMJudge({ client: stubClient(reply('{"score": 0.', 'max_tokens')), model: 'm' });
    await expect(cut.score({ answer: 'a', readContext: 'c' })).rejects.toThrow(/max_tokens/);
    const refused = new LMJudge({ client: stubClient(reply('', 'refusal')), model: 'm' });
    await expect(refused.score({ answer: 'a', readContext: 'c' })).rejects.toThrow(/refus/);
  });
});
