/**
 * Connection Pooling — manages HTTP connections for reuse.
 *
 * Provides a lightweight connection pool that wraps fetch with
 * connection reuse semantics. Uses Node.js's built-in HTTP agent
 * keep-alive when available, or tracks concurrent request limits.
 */

import type { HttpMethod } from './types.js';

// ---------------------------------------------------------------------------
// Connection Pool
// ---------------------------------------------------------------------------

export interface ConnectionPoolConfig {
  /** Maximum concurrent connections per host (default: 10) */
  maxConnections: number;
  /** Keep-alive timeout in ms (default: 30000) */
  keepAliveTimeoutMs: number;
  /** Maximum idle connections to keep (default: 5) */
  maxIdleConnections: number;
}

const DEFAULT_POOL_CONFIG: ConnectionPoolConfig = {
  maxConnections: 10,
  keepAliveTimeoutMs: 30_000,
  maxIdleConnections: 5,
};

interface PendingRequest {
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
  url: string;
  init: RequestInit;
}

/**
 * ConnectionPool — manages concurrent HTTP connections per host.
 *
 * Limits concurrent requests to prevent overwhelming the server,
 * queuing excess requests until a slot opens.
 */
export class ConnectionPool {
  private config: ConnectionPoolConfig;
  private activeConnections: Map<string, number> = new Map();
  private queues: Map<string, PendingRequest[]> = new Map();
  private disposed = false;

  constructor(config?: Partial<ConnectionPoolConfig>) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  /**
   * Execute a fetch request through the connection pool.
   * Queues the request if the host has reached its connection limit.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (this.disposed) {
      throw new Error('Connection pool has been disposed');
    }

    const host = extractHost(url);
    const active = this.activeConnections.get(host) ?? 0;

    if (active >= this.config.maxConnections) {
      // Queue the request
      return new Promise<Response>((resolve, reject) => {
        const queue = this.queues.get(host) ?? [];
        queue.push({ resolve, reject, url, init: init ?? {} });
        this.queues.set(host, queue);
      });
    }

    return this.executeFetch(host, url, init);
  }

  /**
   * Convenience method for common HTTP methods.
   */
  async request(
    url: string,
    method: HttpMethod,
    headers?: Record<string, string>,
    body?: string | FormData | null,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.fetch(url, {
      method,
      headers,
      body,
      signal,
    });
  }

  private async executeFetch(host: string, url: string, init?: RequestInit): Promise<Response> {
    this.activeConnections.set(host, (this.activeConnections.get(host) ?? 0) + 1);

    try {
      const response = await fetch(url, {
        ...init,
        // Enable keep-alive
        keepalive: true,
      });
      return response;
    } finally {
      const active = (this.activeConnections.get(host) ?? 1) - 1;
      if (active <= 0) {
        this.activeConnections.delete(host);
      } else {
        this.activeConnections.set(host, active);
      }

      // Process queued requests
      this.processQueue(host);
    }
  }

  private processQueue(host: string): void {
    const queue = this.queues.get(host);
    if (!queue?.length) return;

    const active = this.activeConnections.get(host) ?? 0;
    if (active >= this.config.maxConnections) return;

    const pending = queue.shift();
    if (!pending) return;

    if (queue.length === 0) {
      this.queues.delete(host);
    }

    this.executeFetch(host, pending.url, pending.init)
      .then(pending.resolve)
      .catch(pending.reject);
  }

  /** Get the number of active connections for a host */
  getActiveConnections(host?: string): number {
    if (host) return this.activeConnections.get(host) ?? 0;
    let total = 0;
    for (const count of this.activeConnections.values()) total += count;
    return total;
  }

  /** Get the number of queued requests for a host */
  getQueuedRequests(host?: string): number {
    if (host) return this.queues.get(host)?.length ?? 0;
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  /** Dispose the pool, rejecting all queued requests */
  dispose(): void {
    this.disposed = true;
    for (const queue of this.queues.values()) {
      for (const pending of queue) {
        pending.reject(new Error('Connection pool disposed'));
      }
    }
    this.queues.clear();
    this.activeConnections.clear();
  }
}

/** Extract the host (protocol + hostname + port) from a URL */
function extractHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}
