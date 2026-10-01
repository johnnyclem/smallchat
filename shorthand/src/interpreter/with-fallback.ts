/**
 * withFallback — combinator that runs `primary`, and on a fallback-eligible
 * error runs `fallback`. Caller-cancellation (AbortError from a caller's
 * signal) propagates without falling back.
 */
import {
  isFallbackEligible,
  silentLogger,
  type InterpretInput,
  type InterpretOptions,
  type Interpreter,
  type InterpreterLogger,
} from './types.js';

export interface WithFallbackOptions {
  logger?: InterpreterLogger;
}

export function withFallback(
  primary: Interpreter,
  fallback: Interpreter,
  options: WithFallbackOptions = {},
): Interpreter {
  const logger = options.logger ?? silentLogger;
  return {
    tier: primary.tier,
    async interpret(input: InterpretInput, opts: InterpretOptions): Promise<string> {
      try {
        return await primary.interpret(input, opts);
      } catch (err) {
        if (!isFallbackEligible(err)) {
          throw err;
        }
        logger.warn('fallback', {
          from: primary.tier,
          to: fallback.tier,
          reason: err instanceof Error ? err.message : String(err),
          errorName: err instanceof Error ? err.name : 'unknown',
        });
        return fallback.interpret(input, opts);
      }
    },
  };
}
