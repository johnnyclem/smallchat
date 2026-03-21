/**
 * HTTP Transport — generic HTTP transport supporting GET/POST/PUT/DELETE.
 *
 * Implements ITransport for standard REST APIs. Integrates:
 *   - Auth strategies (Bearer, OAuth2)
 *   - Input serialization (JSON body, query params, path params)
 *   - Output parsing (JSON, text, binary)
 *   - Retry with exponential backoff
 *   - Circuit breaker
 *   - Configurable timeouts
 *   - Streaming (SSE, NDJSON, chunked)
 *   - File uploads (multipart/form-data)
 *   - Connection pooling
 */

import type {
  ITransport,
  TransportInput,
  TransportOutput,
  HttpTransportConfig,
  HttpTransportRoute,
  TransportKind,
} from './types.js';
import { serializeInput, parseOutput } from './serialization.js';
import { withRetry } from './retry.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { withTimeout } from './timeout.js';
import { getStreamParser } from './streaming.js';
import { buildMultipartBody, requiresMultipart } from './file-upload.js';
import { ConnectionPool } from './connection-pool.js';
import { errorToOutput, httpStatusToError } from './errors.js';

let httpTransportCounter = 0;

export class HttpTransport implements ITransport {
  readonly id: string;
  readonly type: TransportKind = 'http';

  private config: HttpTransportConfig;
  private routes: Map<string, HttpTransportRoute> = new Map();
  private circuitBreaker: CircuitBreaker | null;
  private pool: ConnectionPool;

  constructor(config: HttpTransportConfig) {
    this.id = `http-${++httpTransportCounter}`;
    this.config = config;
    this.circuitBreaker = config.circuitBreaker
      ? new CircuitBreaker(this.id, config.circuitBreaker)
      : null;
    this.pool = new ConnectionPool(
      config.poolSize ? { maxConnections: config.poolSize } : undefined,
    );
  }

  /** Register a route mapping for a tool name */
  addRoute(route: HttpTransportRoute): void {
    this.routes.set(route.toolName, route);
  }

  /** Register multiple routes */
  addRoutes(routes: HttpTransportRoute[]): void {
    for (const route of routes) {
      this.routes.set(route.toolName, route);
    }
  }

  async execute(input: TransportInput): Promise<TransportOutput> {
    const startTime = Date.now();

    try {
      const result = await this.executeWithMiddleware(input);
      result.metadata = {
        ...result.metadata,
        durationMs: Date.now() - startTime,
        circuitState: this.circuitBreaker?.getState(),
      };
      return result;
    } catch (err) {
      const output = errorToOutput(err);
      output.metadata = {
        ...output.metadata,
        durationMs: Date.now() - startTime,
        circuitState: this.circuitBreaker?.getState(),
      };
      return output;
    }
  }

  async *executeStream(input: TransportInput): AsyncGenerator<TransportOutput> {
    const startTime = Date.now();

    try {
      const { url, method, headers, body } = this.buildRequest(input);

      // Apply auth
      if (this.config.auth) {
        await this.config.auth.apply(headers);
      }

      headers['Accept'] = 'text/event-stream';

      const timeoutMs = input.timeoutMs ?? this.config.timeoutMs ?? 30_000;
      const response = await withTimeout(
        (signal) => this.pool.request(url, method, headers, body, signal),
        timeoutMs,
        input.signal,
      );

      if (!response.ok || !response.body) {
        const output = await parseOutput(response);
        yield {
          ...output,
          metadata: { ...output.metadata, durationMs: Date.now() - startTime },
        };
        return;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const parser = getStreamParser(contentType);

      yield* parser(response.body, input.signal);
    } catch (err) {
      yield {
        ...errorToOutput(err),
        metadata: { durationMs: Date.now() - startTime },
      };
    }
  }

  async dispose(): Promise<void> {
    this.pool.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async executeWithMiddleware(input: TransportInput): Promise<TransportOutput> {
    const doRequest = async (attempt: number): Promise<TransportOutput> => {
      const innerFn = async (): Promise<TransportOutput> => {
        const { url, method, headers, body } = this.buildRequest(input);

        // Apply auth
        if (this.config.auth) {
          await this.config.auth.apply(headers);
        }

        const timeoutMs = input.timeoutMs ?? this.config.timeoutMs ?? 30_000;
        const response = await withTimeout(
          (signal) => this.pool.request(url, method, headers, body, signal),
          timeoutMs,
          input.signal,
        );

        const output = await parseOutput(response);
        output.metadata = { ...output.metadata, attempt };

        // Throw on error status so retry can catch it
        if (!response.ok && this.config.retry) {
          throw httpStatusToError(response.status, output.content);
        }

        return output;
      };

      // Wrap with circuit breaker if configured
      if (this.circuitBreaker) {
        return this.circuitBreaker.execute(innerFn);
      }
      return innerFn();
    };

    // Wrap with retry if configured
    if (this.config.retry) {
      return withRetry(doRequest, this.config.retry, input.signal);
    }
    return doRequest(0);
  }

  private buildRequest(input: TransportInput): {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    headers: Record<string, string>;
    body: string | FormData | null;
  } {
    const route = this.routes.get(input.toolName);

    // Handle file uploads
    if (requiresMultipart(input.files)) {
      const path = route?.path ?? input.path ?? input.toolName;
      const base = this.config.baseUrl.replace(/\/$/, '');
      const url = `${base}/${path.replace(/^\//, '')}`;
      const method = input.method ?? route?.method ?? 'POST';
      const headers: Record<string, string> = {
        ...this.config.headers,
        ...route?.headers,
        ...input.headers,
      };
      // Don't set Content-Type — fetch will set it with the boundary
      const body = buildMultipartBody(input.files!, input.args);
      return { url, method, headers, body };
    }

    // Standard request serialization
    const effectiveRoute: HttpTransportRoute | undefined = route
      ? {
          ...route,
          method: input.method ?? route.method,
        }
      : input.path
        ? {
            toolName: input.toolName,
            method: input.method ?? this.config.defaultMethod ?? 'POST',
            path: input.path,
          }
        : input.method
          ? {
              toolName: input.toolName,
              method: input.method,
              path: input.toolName,
            }
          : undefined;

    const serialized = serializeInput(
      this.config.baseUrl,
      input.args,
      effectiveRoute ?? {
        toolName: input.toolName,
        method: this.config.defaultMethod ?? 'POST',
        path: input.toolName,
      },
    );

    const headers: Record<string, string> = {
      ...this.config.headers,
      ...serialized.headers,
      ...input.headers,
    };

    return {
      url: serialized.url,
      method: serialized.method,
      headers,
      body: serialized.body,
    };
  }
}
