/**
 * Circuit Breaker — stops calling failing transports.
 *
 * Implements the standard three-state circuit breaker pattern:
 *   CLOSED  → normal operation, failures counted
 *   OPEN    → all calls rejected immediately
 *   HALF-OPEN → one probe call allowed to test recovery
 *
 * Transitions:
 *   CLOSED → OPEN     when failures reach threshold
 *   OPEN → HALF-OPEN  after resetTimeoutMs elapses
 *   HALF-OPEN → CLOSED when successThreshold probe calls succeed
 *   HALF-OPEN → OPEN   when a probe call fails
 */

import type { CircuitBreakerConfig } from './types.js';
import { CircuitOpenError } from './errors.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  successThreshold: 1,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private config: Required<CircuitBreakerConfig>;
  private readonly transportId: string;

  constructor(transportId: string, config?: Partial<CircuitBreakerConfig>) {
    this.transportId = transportId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute an operation through the circuit breaker.
   * Throws CircuitOpenError if the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new CircuitOpenError(this.transportId);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Check if the circuit allows execution */
  canExecute(): boolean {
    switch (this.state) {
      case 'closed':
        return true;

      case 'open': {
        // Check if enough time has passed to try half-open
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.config.resetTimeoutMs) {
          this.state = 'half-open';
          this.successCount = 0;
          return true;
        }
        return false;
      }

      case 'half-open':
        return true;
    }
  }

  /** Record a successful call */
  onSuccess(): void {
    switch (this.state) {
      case 'half-open':
        this.successCount++;
        if (this.successCount >= this.config.successThreshold) {
          this.state = 'closed';
          this.failureCount = 0;
          this.successCount = 0;
        }
        break;

      case 'closed':
        // Reset failure count on success
        this.failureCount = 0;
        break;
    }
  }

  /** Record a failed call */
  onFailure(): void {
    this.lastFailureTime = Date.now();

    switch (this.state) {
      case 'closed':
        this.failureCount++;
        if (this.failureCount >= this.config.failureThreshold) {
          this.state = 'open';
        }
        break;

      case 'half-open':
        // Probe failed — back to open
        this.state = 'open';
        this.successCount = 0;
        break;
    }
  }

  /** Get the current circuit state */
  getState(): CircuitState {
    // Auto-transition from open to half-open if timeout has elapsed
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = 'half-open';
        this.successCount = 0;
      }
    }
    return this.state;
  }

  /** Force reset the circuit to closed */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /** Get the current failure count */
  getFailureCount(): number {
    return this.failureCount;
  }
}
