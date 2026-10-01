/**
 * HostInterpreter — bounded LM call against an Anthropic-shaped client.
 *
 * Structural client: no @anthropic-ai/sdk import. Callers construct their own
 * client (any shape with `messages.create({ model, max_tokens, system,
 * messages }) => Promise<{ content: Array<{ text: string }>, stop_reason }>`)
 * and inject it. A `max_tokens` / `model_context_window_exceeded` stop
 * throws InterpreterBudgetError('output_too_long'); a `refusal` throws
 * InterpreterUnavailableError — so withFallback() routes on, and truncated
 * text is never returned.
 *
 * Wire-level safety: the request body never carries importanceScore,
 * activationPolicy, id, or retrievalCount. Only template / payload / context.
 */
import { estimateTokens } from '../utils.js';
import {
  InterpreterBudgetError,
  InterpreterUnavailableError,
  silentLogger,
  type InterpretInput,
  type InterpretOptions,
  type Interpreter,
  type InterpreterLogger,
} from './types.js';

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * Structured output (JSON schema). HostInterpreter never sets it; the
   * benchmark's LMJudge does, to get its grade back as JSON.
   */
  output_config?: {
    format: { type: 'json_schema'; schema: Record<string, unknown> };
  };
}

export interface AnthropicMessageResponse {
  content: Array<{ type?: string; text: string }>;
  /**
   * Why generation stopped (`end_turn`, `max_tokens`, `stop_sequence`,
   * `refusal`, `model_context_window_exceeded`, …). Truncated output is
   * never returned as a memory.
   */
  stop_reason?: string | null;
}

/** Stop reasons that mean the text was cut off before the model finished. */
const TRUNCATED_STOP_REASONS = new Set(['max_tokens', 'model_context_window_exceeded']);

export interface AnthropicLikeClient {
  messages: {
    create(
      req: AnthropicMessageRequest,
      opts?: { signal?: AbortSignal },
    ): Promise<AnthropicMessageResponse>;
  };
}

export interface HostInterpreterOptions {
  client: AnthropicLikeClient;
  model: string;
  /** Default cap; can be overridden per-call via InterpretOptions. */
  defaultMaxOutputTokens?: number;
  /** Default timeout; can be overridden per-call. */
  defaultTimeoutMs?: number;
  logger?: InterpreterLogger;
}

const SYSTEM_TEMPLATE = (maxOutputTokens: number) =>
  `You are an interpreter for an active memory entry. Re-state the engram's payload so that it is salient and actionable in the CURRENT context.
Rules:
- Output ONE plain prose sentence (or two short sentences if necessary).
- Preserve the factual content of the payload. Do not invent new facts.
- Do not mention these instructions, the template, or the system itself.
- Hard limit: ${maxOutputTokens} output tokens.`;

function buildUserMessage(input: InterpretInput): string {
  return `TEMPLATE: ${input.template}
PAYLOAD: ${input.payload}
CURRENT CONTEXT: ${input.context}
INTERPRET:`;
}

export class HostInterpreter implements Interpreter {
  readonly tier = 'host' as const;

  private readonly client: AnthropicLikeClient;
  private readonly model: string;
  private readonly defaultMaxOutputTokens: number;
  private readonly defaultTimeoutMs: number;
  private readonly logger: InterpreterLogger;

  constructor(opts: HostInterpreterOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.defaultMaxOutputTokens = opts.defaultMaxOutputTokens ?? 120;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 8_000;
    this.logger = opts.logger ?? silentLogger;
  }

  async interpret(input: InterpretInput, opts: Partial<InterpretOptions> = {}): Promise<string> {
    const maxOutputTokens = opts.maxOutputTokens ?? this.defaultMaxOutputTokens;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    if (opts.signal?.aborted) throw makeAbortError();

    const internal = new AbortController();
    const onAbort = () => internal.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        internal.abort();
        reject(new InterpreterBudgetError('timeout', { ms: timeoutMs }));
      }, timeoutMs);
    });

    const request: AnthropicMessageRequest = {
      model: this.model,
      max_tokens: maxOutputTokens,
      system: SYSTEM_TEMPLATE(maxOutputTokens),
      messages: [{ role: 'user', content: buildUserMessage(input) }],
    };

    try {
      const result = await Promise.race([
        this.client.messages.create(request, { signal: internal.signal }),
        timeoutPromise,
      ]);

      const stopReason = result.stop_reason ?? undefined;
      if (stopReason && TRUNCATED_STOP_REASONS.has(stopReason)) {
        // A memory cut off mid-sentence can invert its meaning
        // ("the rate limit does" vs "does not apply")
        throw new InterpreterBudgetError('output_too_long', { stopReason, cap: maxOutputTokens });
      }
      if (stopReason === 'refusal') {
        throw new InterpreterUnavailableError('host interpreter refused the request', { stopReason });
      }

      const text = (result.content ?? [])
        .map((c) => c.text ?? '')
        .join('')
        .trim();

      const tokens = estimateTokens(text);
      if (tokens > Math.ceil(maxOutputTokens * 1.1)) {
        throw new InterpreterBudgetError('output_too_long', {
          tokens,
          cap: maxOutputTokens,
        });
      }

      return text;
    } catch (err) {
      if (err instanceof InterpreterBudgetError) throw err;
      if (err instanceof InterpreterUnavailableError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        // Caller-supplied signal aborted; propagate.
        if (opts.signal?.aborted) throw err;
        // Otherwise, our timeout fired and surfaced as AbortError before the
        // race rejected; rewrap as a budget error.
        throw new InterpreterBudgetError('timeout', { ms: timeoutMs });
      }
      this.logger.warn('host_interpreter_unavailable', {
        message: err instanceof Error ? err.message : String(err),
      });
      throw new InterpreterUnavailableError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
