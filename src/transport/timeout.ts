/**
 * Timeout — configurable execution timeouts at the transport level.
 *
 * Wraps any async operation with an AbortController-based timeout.
 * Integrates with fetch's native AbortSignal support.
 */

import { TransportTimeoutError } from './errors.js';

/**
 * Execute an async function with a timeout.
 * Returns the result or throws TransportTimeoutError.
 *
 * @param fn - The operation to execute (receives an AbortSignal)
 * @param timeoutMs - Timeout in milliseconds
 * @param existingSignal - Optional existing abort signal to merge with
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  existingSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const { signal } = controller;

  // If there's an existing signal, forward its abort
  if (existingSignal) {
    if (existingSignal.aborted) {
      controller.abort(existingSignal.reason);
    } else {
      existingSignal.addEventListener('abort', () => {
        controller.abort(existingSignal.reason);
      }, { once: true, signal });
    }
  }

  let timer: ReturnType<typeof setTimeout>;
  // Racing against a timer (rather than only calling controller.abort() and
  // awaiting `fn(signal)` directly) matters because not every `fn` actually
  // observes the AbortSignal it's handed — a handler that never checks
  // `signal.aborted` and never rejects would otherwise leave the caller
  // awaiting forever past `timeoutMs`. Racing guarantees this function
  // settles on time regardless of whether `fn` cooperates; the abandoned
  // `fn(signal)` promise keeps running in the background (JS has no true
  // cancellation), but callers stop waiting on it.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new TransportTimeoutError(timeoutMs);
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(signal), timeoutPromise]);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Check if it was our timeout or an external abort
      if (controller.signal.reason instanceof TransportTimeoutError) {
        throw controller.signal.reason;
      }
    }
    throw err;
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Create a merged AbortSignal from a timeout and an optional external signal.
 * Returns the signal and a cleanup function.
 */
export function createTimeoutSignal(
  timeoutMs: number,
  existingSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(new TransportTimeoutError(timeoutMs));
  }, timeoutMs);

  if (existingSignal) {
    if (existingSignal.aborted) {
      clearTimeout(timer);
      controller.abort(existingSignal.reason);
    } else {
      existingSignal.addEventListener('abort', () => {
        clearTimeout(timer);
        controller.abort(existingSignal.reason);
      }, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}
