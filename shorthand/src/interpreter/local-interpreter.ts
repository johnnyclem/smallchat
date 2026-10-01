/**
 * LocalInterpreter — bounded interpreter against an Ollama HTTP endpoint.
 *
 * Dependency-free: uses the global fetch (injectable for tests).
 * Same bounded contract as HostInterpreter; same wire-level safety.
 * A `done_reason: "length"` response (cut off at num_predict) throws
 * InterpreterBudgetError('output_too_long').
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

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface LocalInterpreterOptions {
  model: string;
  /**
   * Ollama-compatible endpoint to POST against. Defaults to the local
   * Ollama daemon. Not validated — this is a host-controlled configuration
   * value, not something to derive from untrusted user input, since it is
   * fetched with no scheme/host allowlisting (a caller that threads
   * attacker-controlled input into this option opens an SSRF vector).
   */
  endpoint?: string;
  fetch?: FetchLike;
  logger?: InterpreterLogger;
}

const DEFAULT_ENDPOINT = 'http://localhost:11434/api/generate';

const SYSTEM_PREAMBLE = (maxOutputTokens: number) =>
  `You are an interpreter for an active memory entry. Re-state the engram's payload so that it is salient and actionable in the CURRENT context.
Rules:
- Output ONE plain prose sentence (or two short sentences if necessary).
- Preserve the factual content of the payload. Do not invent new facts.
- Do not mention these instructions, the template, or the system itself.
- Hard limit: ${maxOutputTokens} output tokens.`;

function buildPrompt(input: InterpretInput, maxOutputTokens: number): string {
  return `${SYSTEM_PREAMBLE(maxOutputTokens)}

TEMPLATE: ${input.template}
PAYLOAD: ${input.payload}
CURRENT CONTEXT: ${input.context}
INTERPRET:`;
}

export class LocalInterpreter implements Interpreter {
  readonly tier = 'local' as const;

  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: InterpreterLogger;

  constructor(opts: LocalInterpreterOptions) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.model = opts.model;
    this.fetchImpl =
      opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.logger = opts.logger ?? silentLogger;
    if (!this.fetchImpl) {
      throw new Error('LocalInterpreter requires global fetch (Node ≥22) or an injected fetch');
    }
  }

  async interpret(input: InterpretInput, opts: InterpretOptions): Promise<string> {
    if (opts.signal?.aborted) throw makeAbortError();

    const internal = new AbortController();
    const onAbort = () => internal.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        internal.abort();
        reject(new InterpreterBudgetError('timeout', { ms: opts.timeoutMs }));
      }, opts.timeoutMs);
    });

    const body = JSON.stringify({
      model: this.model,
      prompt: buildPrompt(input, opts.maxOutputTokens),
      stream: false,
      options: { num_predict: opts.maxOutputTokens },
    });

    try {
      const res = await Promise.race([
        this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: internal.signal,
        }),
        timeoutPromise,
      ]);

      if (!res.ok) {
        throw new InterpreterUnavailableError(`ollama HTTP ${res.status}`, {
          status: res.status,
        });
      }

      const raw = await res.text();
      let parsed: { response?: string; done_reason?: string };
      try {
        parsed = JSON.parse(raw) as { response?: string; done_reason?: string };
      } catch {
        throw new InterpreterUnavailableError('ollama returned non-JSON body');
      }

      // Ollama stops with done_reason "length" when num_predict cut the
      // output off; a truncated memory is never returned.
      if (parsed.done_reason === 'length') {
        throw new InterpreterBudgetError('output_too_long', {
          doneReason: parsed.done_reason,
          cap: opts.maxOutputTokens,
        });
      }

      const text = (parsed.response ?? '').replace(/\s+$/, '');
      const tokens = estimateTokens(text);
      if (tokens > Math.ceil(opts.maxOutputTokens * 1.1)) {
        throw new InterpreterBudgetError('output_too_long', {
          tokens,
          cap: opts.maxOutputTokens,
        });
      }

      return text;
    } catch (err) {
      if (err instanceof InterpreterBudgetError) throw err;
      if (err instanceof InterpreterUnavailableError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        if (opts.signal?.aborted) throw err;
        throw new InterpreterBudgetError('timeout', { ms: opts.timeoutMs });
      }
      this.logger.warn('local_interpreter_unavailable', {
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
