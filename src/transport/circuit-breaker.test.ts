/**
 * Feature: Circuit Breaker Pattern
 *
 * The circuit breaker implements a three-state pattern (closed, open, half-open)
 * to stop calling failing transports and allow recovery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { CircuitOpenError } from './errors.js';

describe('Feature: Circuit Breaker Pattern', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test-transport', {
      failureThreshold: 3,
      resetTimeoutMs: 100,
      successThreshold: 2,
    });
  });

  describe('Scenario: Normal operation in closed state', () => {
    it('Given a new circuit breaker, When getState is called, Then it returns closed', () => {
      expect(breaker.getState()).toBe('closed');
    });

    it('Given a closed circuit, When execute succeeds, Then it returns the result', async () => {
      const result = await breaker.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
      expect(breaker.getState()).toBe('closed');
    });

    it('Given a closed circuit, When execute succeeds, Then failure count resets', async () => {
      // Cause 2 failures (below threshold)
      for (let i = 0; i < 2; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(breaker.getFailureCount()).toBe(2);

      // Success resets the counter
      await breaker.execute(() => Promise.resolve('ok'));
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('Scenario: Circuit opens after reaching failure threshold', () => {
    it('Given a closed circuit, When failures reach the threshold, Then the circuit opens', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch {}
      }

      expect(breaker.getState()).toBe('open');
      expect(breaker.getFailureCount()).toBe(3);
    });

    it('Given an open circuit, When execute is called, Then it throws CircuitOpenError without calling the function', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }

      const fn = vi.fn();
      await expect(breaker.execute(fn)).rejects.toThrow(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: Circuit transitions from open to half-open after timeout', () => {
    it('Given an open circuit, When the reset timeout elapses, Then the circuit becomes half-open', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(breaker.getState()).toBe('open');

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(breaker.getState()).toBe('half-open');
    });
  });

  describe('Scenario: Half-open circuit closes after success threshold', () => {
    it('Given a half-open circuit, When enough probe calls succeed, Then the circuit closes', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(breaker.getState()).toBe('half-open');

      // Success threshold is 2
      await breaker.execute(() => Promise.resolve('probe-1'));
      expect(breaker.getState()).toBe('half-open');

      await breaker.execute(() => Promise.resolve('probe-2'));
      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('Scenario: Half-open circuit reopens on probe failure', () => {
    it('Given a half-open circuit, When a probe call fails, Then the circuit reopens', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(breaker.getState()).toBe('half-open');

      // Probe fails
      try {
        await breaker.execute(() => Promise.reject(new Error('probe-fail')));
      } catch {}

      expect(breaker.getState()).toBe('open');
    });
  });

  describe('Scenario: Manual reset', () => {
    it('Given an open circuit, When reset is called, Then the circuit closes and counters are zeroed', async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(breaker.getState()).toBe('open');

      breaker.reset();

      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('Scenario: canExecute reflects state accurately', () => {
    it('Given a closed circuit, When canExecute is called, Then it returns true', () => {
      expect(breaker.canExecute()).toBe(true);
    });

    it('Given an open circuit within timeout, When canExecute is called, Then it returns false', async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(breaker.canExecute()).toBe(false);
    });
  });

  describe('Scenario: Default configuration', () => {
    it('Given no config, When creating a circuit breaker, Then defaults are applied (threshold=5)', async () => {
      const defaultBreaker = new CircuitBreaker('default');

      // Should tolerate 4 failures without opening
      for (let i = 0; i < 4; i++) {
        try { await defaultBreaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(defaultBreaker.getState()).toBe('closed');

      // 5th failure opens it
      try { await defaultBreaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      expect(defaultBreaker.getState()).toBe('open');
    });
  });
});
