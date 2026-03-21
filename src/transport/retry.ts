/**
 * Retry Logic — exponential backoff with jitter.
 *
 * Wraps any async operation with configurable retry behavior.
 * Only retries on errors marked as retryable (network failures,
 * 5xx responses, rate limits, etc.).
 */

import type { RetryConfig } from './types.js';
import { isRetryable } from './errors.js';

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0.1,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
};

/**
 * Execute an async function with exponential backoff retry.
 *
 * @param fn - The operation to retry
 * @param config - Retry configuration
 * @param signal - Optional AbortSignal for cancellation
 * @returns The result of the first successful call
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config?: Partial<RetryConfig>,
  signal?: AbortSignal,
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // Don't retry on the last attempt or non-retryable errors
      if (attempt >= cfg.maxRetries || !isRetryable(err)) {
        throw err;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = calculateDelay(attempt, cfg.baseDelayMs, cfg.maxDelayMs, cfg.jitter);

      // Wait before retrying
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

/**
 * Calculate the delay for a given attempt using exponential backoff with jitter.
 */
export function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: number,
): number {
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter: ±jitter% of the delay
  const jitterRange = cappedDelay * jitter;
  const jitterOffset = (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(cappedDelay + jitterOffset));
}

/** Sleep with abort signal support */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
