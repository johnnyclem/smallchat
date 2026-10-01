/**
 * Pluggable scorers for the context-shift benchmark.
 *
 * KeywordJudge — recall of expectedAnswer tokens. Deterministic, CI-safe.
 * LMJudge      — a grading call to an Anthropic-shaped client (structured output).
 */
import type { AnthropicLikeClient } from '../interpreter/host-interpreter.js';
import { callModelText, ModelCallError } from './model-call.js';

export interface JudgeArgs {
  answer: string;
  expectedAnswer?: string;
  rubric?: string;
  readContext: string;
}

export interface Judge {
  readonly name: 'keyword' | 'lm';
  score(args: JudgeArgs): Promise<number>;
}

const TOKEN_RX = /[a-z0-9]+/g;
const STOPWORDS = new Set([
  'the','a','an','of','and','or','to','for','in','on','at','is','are','was','were',
  'be','been','being','it','this','that','as','with','by','from','into','about',
  'we','you','i','our','their','its','his','her',
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(TOKEN_RX) ?? []).filter((t) => !STOPWORDS.has(t));
}

function recall(answerTokens: string[], expectedTokens: string[]): number {
  if (expectedTokens.length === 0) return 0;
  const a = new Set(answerTokens);
  const e = new Set(expectedTokens);
  let overlap = 0;
  for (const t of e) if (a.has(t)) overlap++;
  return overlap / e.size;
}

/**
 * KeywordJudge — recall of expected tokens in the answer (with a substring
 * fallback for very short expected strings).
 *
 * Recall, not F1: we are scoring "did the injected text surface the right
 * information?", and a longer interpreted output that includes more relevant
 * terms is exactly the signal we want to reward. Penalizing length (F1)
 * would defeat the purpose for the echo-answerer benchmark setup.
 */
export class KeywordJudge implements Judge {
  readonly name = 'keyword' as const;

  async score(args: JudgeArgs): Promise<number> {
    const expected = args.expectedAnswer ?? args.rubric ?? '';
    if (!expected) return 0;

    // Verbatim short string (UUIDs, fingerprints): substring is the right test.
    if (expected.length <= 32 && /[A-Z0-9:]{6,}/.test(expected)) {
      return args.answer.includes(expected) ? 1 : 0;
    }

    const expectedTokens = tokenize(expected);
    const answerTokens = tokenize(args.answer);
    return recall(answerTokens, expectedTokens);
  }
}

export interface LMJudgeOptions {
  /** Anthropic-shaped client (`messages.create`), as for HostInterpreter. */
  client: AnthropicLikeClient;
  model: string;
  /** Output cap for the grade. Default 200. */
  maxOutputTokens?: number;
  /** Default 15 000 ms. */
  timeoutMs?: number;
}

const JUDGE_SYSTEM = `You are a strict grader. You score how well an ANSWER satisfies a RUBRIC, given the READ-TIME CONTEXT the answer was written for.
Rules:
- Score from 0.0 (does not satisfy the rubric, or contradicts it) to 1.0 (fully satisfies it).
- Judge correctness and relevance to the rubric only. Do not reward length, tone or restatement.
- Reply with a JSON object: {"score": <number from 0 to 1>, "reason": "<at most 20 words>"}.`;

const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
  additionalProperties: false,
};

/**
 * LMJudge — grades with its own call: a grading system prompt and a JSON
 * schema for the reply (structured output). It never goes through an
 * Interpreter, whose system prompt asks for one prose sentence (SH-19).
 *
 * A failed, truncated, refused or unparseable grade, or a score outside
 * [0, 1], throws ModelCallError instead of scoring 0: a run with a broken
 * judge fails rather than reporting losses it never measured.
 */
export class LMJudge implements Judge {
  readonly name = 'lm' as const;

  private readonly client: AnthropicLikeClient;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: LMJudgeOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.maxOutputTokens = opts.maxOutputTokens ?? 200;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async score(args: JudgeArgs): Promise<number> {
    const rubric =
      args.rubric ??
      (args.expectedAnswer
        ? `The answer conveys: ${args.expectedAnswer}`
        : 'The answer is correct and relevant to the read-time context.');

    const raw = await callModelText(
      this.client,
      {
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system: JUDGE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `RUBRIC: ${rubric}\nREAD-TIME CONTEXT: ${args.readContext}\nANSWER: ${args.answer}`,
          },
        ],
        output_config: { format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
      },
      this.timeoutMs,
      'judge',
    );
    return parseScore(raw);
  }
}

function parseScore(raw: string): number {
  let parsed: { score?: unknown };
  try {
    parsed = JSON.parse(raw) as { score?: unknown };
  } catch {
    throw new ModelCallError('judge: the grade is not a JSON object', { raw });
  }
  const score = parsed?.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new ModelCallError('judge: the grade has no score between 0 and 1', { raw });
  }
  return score;
}
