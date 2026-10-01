/**
 * Bounded interpreter contract.
 *
 * The interpreter step runs at engram-retrieval time. It takes the engram's
 * payload + interpreterTemplate and the current context, and returns a single
 * contextualized string ready for injection.
 *
 * Three rules encoded structurally:
 *   1. Bounded: every interpret() call carries a maxOutputTokens cap and a
 *      timeoutMs. Implementations MUST throw InterpreterBudgetError when
 *      either is exceeded.
 *   2. Safety: InterpretInput exposes only template / payload / context.
 *      importanceScore, activationPolicy, id, and retrievalCount never reach
 *      the interpreter. The LM cannot see them and cannot influence them.
 *   3. Fallible: when a backend is unavailable (no API key, network refused,
 *      missing local model), implementations throw InterpreterUnavailableError
 *      so withFallback() can route deterministically.
 */
export type InterpreterTier = 'regex' | 'local' | 'host';

export interface InterpretInput {
  template: string;
  payload: string;
  context: string;
}

export interface InterpretOptions {
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Interpreter {
  readonly tier: InterpreterTier;
  interpret(input: InterpretInput, opts: InterpretOptions): Promise<string>;
}

export type InterpreterBudgetReason = 'timeout' | 'output_too_long';

export class InterpreterBudgetError extends Error {
  readonly reason: InterpreterBudgetReason;
  readonly meta: Record<string, unknown>;

  constructor(reason: InterpreterBudgetReason, meta: Record<string, unknown> = {}) {
    super(`interpreter budget exceeded: ${reason}`);
    this.name = 'InterpreterBudgetError';
    this.reason = reason;
    this.meta = meta;
  }
}

export class InterpreterUnavailableError extends Error {
  readonly meta: Record<string, unknown>;

  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message);
    this.name = 'InterpreterUnavailableError';
    this.meta = meta;
  }
}

export interface InterpreterLogger {
  warn(event: string, meta: Record<string, unknown>): void;
}

export const silentLogger: InterpreterLogger = {
  warn() {
    /* no-op */
  },
};

/**
 * True when the error should trigger a fallback in withFallback().
 * AbortError from a caller-supplied signal does NOT trigger fallback —
 * caller cancellation must propagate.
 */
export function isFallbackEligible(err: unknown): boolean {
  if (err instanceof InterpreterBudgetError) return true;
  if (err instanceof InterpreterUnavailableError) return true;
  if (err instanceof Error && err.name === 'AbortError') return false;
  return err instanceof Error;
}
