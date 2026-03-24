/**
 * Feature: Timeout Management
 *
 * The timeout module wraps async operations with AbortController-based timeouts,
 * integrating with fetch's native AbortSignal support.
 */

import { describe, it, expect } from 'vitest';
import { withTimeout, createTimeoutSignal } from './timeout.js';
import { TransportTimeoutError } from './errors.js';

describe('Feature: Timeout Management', () => {
  describe('Scenario: Operation completes within timeout', () => {
    it('Given an operation that resolves quickly, When withTimeout is called, Then it returns the result', async () => {
      const result = await withTimeout(
        async () => 'fast-result',
        5000,
      );
      expect(result).toBe('fast-result');
    });
  });

  describe('Scenario: Operation exceeds timeout', () => {
    it('Given an operation that takes too long, When the timeout elapses, Then a TransportTimeoutError is thrown', async () => {
      await expect(
        withTimeout(
          (signal) => new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason);
            });
          }),
          10,
        ),
      ).rejects.toThrow(TransportTimeoutError);
    });
  });

  describe('Scenario: Operation uses the provided signal', () => {
    it('Given an operation that checks the signal, When withTimeout is called, Then the signal is passed through', async () => {
      let receivedSignal: AbortSignal | undefined;
      await withTimeout(
        async (signal) => {
          receivedSignal = signal;
          return 'done';
        },
        5000,
      );
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(false);
    });
  });

  describe('Scenario: Existing signal is already aborted', () => {
    it('Given an existing signal that is already aborted, When withTimeout is called, Then the internal signal is also aborted', async () => {
      const controller = new AbortController();
      controller.abort('test-reason');

      let receivedSignal: AbortSignal | undefined;
      try {
        await withTimeout(
          async (signal) => {
            receivedSignal = signal;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            return 'never';
          },
          5000,
          controller.signal,
        );
      } catch {
        // Expected to throw
      }

      expect(receivedSignal?.aborted).toBe(true);
    });
  });

  describe('Scenario: External abort propagates', () => {
    it('Given an external signal that aborts mid-operation, When the signal fires, Then the operation is aborted', async () => {
      const controller = new AbortController();

      const promise = withTimeout(
        async (signal) => {
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
        },
        5000,
        controller.signal,
      );

      // Abort externally
      setTimeout(() => controller.abort(), 10);

      await expect(promise).rejects.toThrow();
    });
  });

  describe('Scenario: Timeout error contains correct duration', () => {
    it('Given a 50ms timeout, When it fires, Then the error message contains the timeout value', async () => {
      try {
        await withTimeout(
          (signal) => new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason);
            });
          }),
          50,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(TransportTimeoutError);
        expect((err as TransportTimeoutError).message).toContain('50ms');
      }
    });
  });

  describe('Feature: createTimeoutSignal', () => {
    describe('Scenario: Creates a signal with cleanup', () => {
      it('Given a timeout of 5000ms, When createTimeoutSignal is called, Then it returns a signal and cleanup function', () => {
        const { signal, cleanup } = createTimeoutSignal(5000);
        expect(signal).toBeDefined();
        expect(signal.aborted).toBe(false);
        expect(typeof cleanup).toBe('function');
        cleanup(); // Must not throw
      });
    });

    describe('Scenario: Signal aborts after timeout', () => {
      it('Given a 10ms timeout, When the timeout elapses, Then the signal is aborted with TransportTimeoutError', async () => {
        const { signal } = createTimeoutSignal(10);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBeInstanceOf(TransportTimeoutError);
      });
    });

    describe('Scenario: Pre-aborted existing signal', () => {
      it('Given an already-aborted signal, When createTimeoutSignal is called, Then the resulting signal is immediately aborted', () => {
        const controller = new AbortController();
        controller.abort('pre-aborted');
        const { signal, cleanup } = createTimeoutSignal(5000, controller.signal);
        expect(signal.aborted).toBe(true);
        cleanup();
      });
    });
  });
});
