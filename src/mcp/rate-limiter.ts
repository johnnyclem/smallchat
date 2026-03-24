/**
 * RateLimiter — sliding-window per-client rate limiter.
 *
 * Each client gets a 60-second window. If the request count exceeds
 * maxRPM within that window, subsequent requests are rejected.
 */

export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxRPM: number = 600) {}

  /** Returns true if the request is allowed, false if rate-limited. */
  check(clientId: string): boolean {
    const now = Date.now();
    const window = this.windows.get(clientId);

    if (!window || now > window.resetAt) {
      this.windows.set(clientId, { count: 1, resetAt: now + 60_000 });
      return true;
    }

    if (window.count >= this.maxRPM) {
      return false;
    }

    window.count++;
    return true;
  }
}
