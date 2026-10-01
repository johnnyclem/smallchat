/**
 * Live wiring for the context-shift benchmark (`npm run benchmark:live`).
 *
 * Everything runs on one Anthropic-shaped client and model:
 *   interpreter — HostInterpreter, with no fallback tier: a failed
 *                 interpretation is recorded in the report and fails the gate
 *   answerer    — its own call: answer the question from the injected memory
 *   judge       — LMJudge: its own grading call with structured output
 *
 * A failed answer or grade throws ModelCallError and fails the run; nothing
 * falls back to the echo answerer or to a score of 0 (SH-19).
 */
import { HostInterpreter, type AnthropicLikeClient } from '../interpreter/host-interpreter.js';
import type { InterpretOptions, InterpreterLogger } from '../interpreter/types.js';
import { ContextShiftBenchmark, type Answerer, type GateOptions } from './context-shift-benchmark.js';
import { LMJudge } from './judges.js';
import { callModelText } from './model-call.js';

/**
 * Model the live run uses unless SHORTHAND_BENCHMARK_MODEL is set. A small,
 * non-thinking model, because the interpreter call is capped at 120 output
 * tokens. Model ids retire: if this one stops resolving, the run fails on
 * every call instead of producing a report.
 */
export const DEFAULT_LIVE_MODEL = 'claude-haiku-4-5';

/**
 * Interpretation budget for live runs: pass as `run(fixtures, { interpretOpts })`.
 * (ActiveEngramStore's own default timeout, 4 s, is tight for a network call.)
 */
export const LIVE_INTERPRET_OPTIONS: InterpretOptions = { maxOutputTokens: 120, timeoutMs: 15_000 };

const ANSWER_SYSTEM = `You answer a QUESTION using only the MEMORY you are given and the READ-TIME CONTEXT it is being used in.
Rules:
- Use only the MEMORY and the READ-TIME CONTEXT. Do not invent facts.
- Answer in one or two short sentences.`;

export interface AnthropicAnswererOptions {
  client: AnthropicLikeClient;
  model: string;
  /** Default 120. */
  maxOutputTokens?: number;
  /** Default 15 000 ms. */
  timeoutMs?: number;
}

/**
 * A downstream answerer that asks the model the fixture's question with the
 * injected text as its only memory. Failures throw ModelCallError.
 */
export function createAnthropicAnswerer(opts: AnthropicAnswererOptions): Answerer {
  const maxOutputTokens = opts.maxOutputTokens ?? 120;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return ({ question, injected, readContext }) =>
    callModelText(
      opts.client,
      {
        model: opts.model,
        max_tokens: maxOutputTokens,
        system: ANSWER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `MEMORY: ${injected}\nREAD-TIME CONTEXT: ${readContext}\nQUESTION: ${question}`,
          },
        ],
      },
      timeoutMs,
      'answerer',
    );
}

export interface LiveBenchmarkOptions {
  client: AnthropicLikeClient;
  /** Default DEFAULT_LIVE_MODEL. */
  model?: string;
  /** Receives interpretation-failure warnings. */
  logger?: InterpreterLogger;
  gate?: GateOptions;
}

/** The live benchmark: host interpreter (no fallback), model answerer, LM judge. */
export function createLiveBenchmark(opts: LiveBenchmarkOptions): ContextShiftBenchmark {
  const model = opts.model ?? DEFAULT_LIVE_MODEL;
  return new ContextShiftBenchmark({
    interpreter: new HostInterpreter({ client: opts.client, model, logger: opts.logger }),
    judge: new LMJudge({ client: opts.client, model }),
    answerer: createAnthropicAnswerer({ client: opts.client, model }),
    logger: opts.logger,
    gate: opts.gate,
  });
}
