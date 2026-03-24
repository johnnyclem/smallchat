/**
 * Feature: Rate Limiter
 *
 * Sliding-window per-client rate limiter. Each client gets a 60-second window.
 * If the request count exceeds maxRPM, subsequent requests are rejected.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('Feature: Per-Client Rate Limiting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Scenario: First request is always allowed', () => {
    it('Given a new rate limiter, When the first request arrives, Then it is allowed', () => {
      const limiter = new RateLimiter(100);
      expect(limiter.check('client-1')).toBe(true);
    });
  });

  describe('Scenario: Requests within limit are allowed', () => {
    it('Given a limit of 5, When 5 requests are made, Then all are allowed', () => {
      const limiter = new RateLimiter(5);

      for (let i = 0; i < 5; i++) {
        expect(limiter.check('client-1')).toBe(true);
      }
    });
  });

  describe('Scenario: Requests exceeding limit are rejected', () => {
    it('Given a limit of 3, When 4 requests are made, Then the 4th is rejected', () => {
      const limiter = new RateLimiter(3);

      expect(limiter.check('client-1')).toBe(true);
      expect(limiter.check('client-1')).toBe(true);
      expect(limiter.check('client-1')).toBe(true);
      expect(limiter.check('client-1')).toBe(false);
    });
  });

  describe('Scenario: Different clients have independent limits', () => {
    it('Given client-1 at the limit, When client-2 makes a request, Then client-2 is allowed', () => {
      const limiter = new RateLimiter(2);

      expect(limiter.check('client-1')).toBe(true);
      expect(limiter.check('client-1')).toBe(true);
      expect(limiter.check('client-1')).toBe(false); // client-1 at limit

      expect(limiter.check('client-2')).toBe(true); // client-2 is fine
    });
  });

  describe('Scenario: Window resets after 60 seconds', () => {
    it('Given a client at the limit, When 60 seconds pass, Then requests are allowed again', () => {
      const limiter = new RateLimiter(1);

      expect(limiter.check('client-1')).toBe(true);
      expect(limiter.check('client-1')).toBe(false);

      // Advance time past the 60-second window
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);

      expect(limiter.check('client-1')).toBe(true);
    });
  });

  describe('Scenario: Default maxRPM is 600', () => {
    it('Given no maxRPM specified, When creating a rate limiter, Then 600 requests are allowed per minute', () => {
      const limiter = new RateLimiter();

      // Should allow at least 600 requests
      for (let i = 0; i < 600; i++) {
        expect(limiter.check('client-1')).toBe(true);
      }

      expect(limiter.check('client-1')).toBe(false);
    });
  });
});
