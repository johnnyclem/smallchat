/**
 * RegexInterpreter — the zero-dependency baseline tier.
 *
 * String substitution of {{payload}} and {{context}} into the template.
 * No LM call. Always available; used as the terminal fallback.
 */
import { estimateTokens } from '../utils.js';
import {
  InterpreterBudgetError,
  type InterpretInput,
  type InterpretOptions,
  type Interpreter,
} from './types.js';

export function resolveTemplate(
  template: string,
  payload: string,
  context: string,
): string {
  // Function replacements: a payload containing `$&` / `$'` must be inserted
  // literally, not expanded as a replacement pattern.
  return template
    .replace(/\{\{payload\}\}/g, () => payload)
    .replace(/\{\{context\}\}/g, () => context);
}

export class RegexInterpreter implements Interpreter {
  readonly tier = 'regex' as const;

  async interpret(input: InterpretInput, opts: InterpretOptions): Promise<string> {
    if (opts.signal?.aborted) {
      throw makeAbortError();
    }

    const out = resolveTemplate(input.template, input.payload, input.context);

    if (estimateTokens(out) > opts.maxOutputTokens) {
      throw new InterpreterBudgetError('output_too_long', {
        tokens: estimateTokens(out),
        cap: opts.maxOutputTokens,
      });
    }

    return out;
  }
}

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
