/**
 * Feature: Retry Logic with Exponential Backoff
 *
 * The retry module wraps async operations with configurable retry behavior,
 * using exponential backoff with jitter. Only retryable errors trigger retries.
 */

import { describe, it, expect, vi } from 'vitest';
import { withRetry, calculateDelay } from './retry.js';
import { ToolExecutionError } from './errors.js';

describe('Feature: Retry Logic with Exponential Backoff', () => {
  describe('Scenario: Successful operation on first attempt', () => {
    it('Given an operation that succeeds, When withRetry is called, Then it returns the result without retrying', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await withRetry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(0);
    });
  });

  describe('Scenario: Operation succeeds after transient failures', () => {
    it('Given an operation that fails twice with retryable errors then succeeds, When withRetry is called, Then it retries and returns the result', async () => {
      const retryableError = new ToolExecutionError('Server error', {
        code: 'INTERNAL_SERVER_ERROR',
        statusCode: 500,
        retryable: true,
      });
      const fn = vi.fn()
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValueOnce('recovered');

      const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 10 });

      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(3);
      expect(fn).toHaveBeenCalledWith(0);
      expect(fn).toHaveBeenCalledWith(1);
      expect(fn).toHaveBeenCalledWith(2);
    });
  });

  describe('Scenario: Non-retryable error is thrown immediately', () => {
    it('Given an operation that fails with a non-retryable error, When withRetry is called, Then it throws immediately without retrying', async () => {
      const nonRetryableError = new ToolExecutionError('Forbidden', {
        code: 'FORBIDDEN',
        statusCode: 403,
        retryable: false,
      });
      const fn = vi.fn().mockRejectedValue(nonRetryableError);

      await expect(withRetry(fn)).rejects.toThrow('Forbidden');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scenario: All retry attempts exhausted', () => {
    it('Given an operation that always fails with retryable errors, When maxRetries is reached, Then the last error is thrown', async () => {
      const retryableError = new ToolExecutionError('Timeout', {
        code: 'REQUEST_TIMEOUT',
        statusCode: 408,
        retryable: true,
      });
      const fn = vi.fn().mockRejectedValue(retryableError);

      await expect(
        withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 }),
      ).rejects.toThrow('Timeout');
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('Scenario: Abort signal cancels retry loop', () => {
    it('Given an abort signal that is already aborted, When withRetry is called, Then it throws an AbortError immediately', async () => {
      const controller = new AbortController();
      controller.abort();
      const fn = vi.fn().mockResolvedValue('never');

      await expect(withRetry(fn, {}, controller.signal)).rejects.toThrow('Aborted');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: Custom retry configuration', () => {
    it('Given a custom maxRetries of 1, When the operation fails twice, Then it retries only once', async () => {
      const retryableError = new ToolExecutionError('Error', {
        code: 'INTERNAL_SERVER_ERROR',
        statusCode: 500,
        retryable: true,
      });
      const fn = vi.fn().mockRejectedValue(retryableError);

      await expect(
        withRetry(fn, { maxRetries: 1, baseDelayMs: 1 }),
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Feature: calculateDelay', () => {
    describe('Scenario: Exponential backoff calculation', () => {
      it('Given attempt 0 with 1000ms base delay, When calculateDelay is called, Then the delay is approximately 1000ms', () => {
        const delay = calculateDelay(0, 1000, 30000, 0);
        expect(delay).toBe(1000);
      });

      it('Given attempt 1, When calculateDelay is called, Then the delay doubles', () => {
        const delay = calculateDelay(1, 1000, 30000, 0);
        expect(delay).toBe(2000);
      });

      it('Given attempt 2, When calculateDelay is called, Then the delay quadruples', () => {
        const delay = calculateDelay(2, 1000, 30000, 0);
        expect(delay).toBe(4000);
      });
    });

    describe('Scenario: Delay is capped at maxDelayMs', () => {
      it('Given a high attempt number, When calculateDelay is called, Then the delay does not exceed maxDelayMs', () => {
        const delay = calculateDelay(10, 1000, 5000, 0);
        expect(delay).toBe(5000);
      });
    });

    describe('Scenario: Jitter adds randomness', () => {
      it('Given jitter of 0.5, When calculateDelay is called multiple times, Then results vary', () => {
        const delays = new Set<number>();
        for (let i = 0; i < 20; i++) {
          delays.add(calculateDelay(0, 1000, 30000, 0.5));
        }
        // With 50% jitter on 1000ms base, range is 500-1500
        for (const d of delays) {
          expect(d).toBeGreaterThanOrEqual(500);
          expect(d).toBeLessThanOrEqual(1500);
        }
      });
    });

    describe('Scenario: Zero jitter returns exact delay', () => {
      it('Given jitter of 0, When calculateDelay is called, Then the result is deterministic', () => {
        const d1 = calculateDelay(0, 1000, 30000, 0);
        const d2 = calculateDelay(0, 1000, 30000, 0);
        expect(d1).toBe(d2);
        expect(d1).toBe(1000);
      });
    });
  });
});
