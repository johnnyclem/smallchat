/**
 * One bounded call to an Anthropic-shaped client for the benchmark's live
 * answerer and judge. Unlike the interpreter tiers there is no fallback: a
 * failed, truncated or refused call throws ModelCallError, so a live run
 * fails loudly instead of scoring a stand-in (SH-19).
 */
import type {
  AnthropicLikeClient,
  AnthropicMessageRequest,
} from '../interpreter/host-interpreter.js';

/** Stop reasons that mean the text was cut off before the model finished. */
const TRUNCATED_STOP_REASONS = new Set(['max_tokens', 'model_context_window_exceeded']);

export class ModelCallError extends Error {
  readonly meta: Record<string, unknown>;

  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ModelCallError';
    this.meta = meta;
  }
}

/**
 * Send `request` and return the response text. Throws ModelCallError when
 * the call fails or takes longer than `timeoutMs`, when the output was
 * truncated or refused, or when it is empty. `what` names the caller in
 * error messages ('answerer', 'judge').
 */
export async function callModelText(
  client: AnthropicLikeClient,
  request: AnthropicMessageRequest,
  timeoutMs: number,
  what: string,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelCallError(`${what}: no response within ${timeoutMs} ms`, { timeoutMs }));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      client.messages.create(request, { signal: controller.signal }),
      timeout,
    ]);
    const stopReason = result.stop_reason ?? undefined;
    if (stopReason && TRUNCATED_STOP_REASONS.has(stopReason)) {
      throw new ModelCallError(`${what}: output truncated (stop_reason ${stopReason})`, {
        stopReason,
        maxTokens: request.max_tokens,
      });
    }
    if (stopReason === 'refusal') {
      throw new ModelCallError(`${what}: the model refused the request`, { stopReason });
    }
    const text = (result.content ?? [])
      .map((c) => c.text ?? '')
      .join('')
      .trim();
    if (!text) throw new ModelCallError(`${what}: empty response`, { stopReason });
    return text;
  } catch (err) {
    if (err instanceof ModelCallError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ModelCallError(`${what}: ${message}`, { model: request.model });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
