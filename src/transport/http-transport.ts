/**
 * HTTP Transport — generic HTTP transport supporting GET/POST/PUT/DELETE.
 *
 * Implements ITransport for standard REST APIs. Integrates:
 *   - Auth strategies (Bearer, OAuth2), applied inside the request timeout
 *   - Input serialization (JSON body, query params, path params)
 *   - Output parsing (JSON, text, binary)
 *   - Retry with exponential backoff — idempotent methods only, unless
 *     RetryConfig.retryNonIdempotent opts in (then every attempt of one
 *     logical call carries the same generated Idempotency-Key)
 *   - Circuit breaker (5xx responses, timeouts and network errors count)
 *   - Configurable timeouts
 *   - Streaming (SSE, NDJSON, chunked)
 *   - File uploads (multipart/form-data; streams are buffered, capped)
 *   - Connection pooling
 */

import { randomUUID } from 'node:crypto';
import type {
  ITransport,
  TransportInput,
  TransportOutput,
  HttpTransportConfig,
  HttpTransportRoute,
  HttpMethod,
  TransportKind,
  FileUpload,
} from './types.js';
import { serializeInput, parseOutput } from './serialization.js';
import { withRetry } from './retry.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { withTimeout } from './timeout.js';
import { getStreamParser } from './streaming.js';
import { buildMultipartBody, bufferFileUploads, requiresMultipart } from './file-upload.js';
import { ConnectionPool } from './connection-pool.js';
import { errorToOutput, httpStatusToError, ToolExecutionError } from './errors.js';

let httpTransportCounter = 0;

/** Methods whose repetition has no additional effect (RFC 9110 §9.2.2). */
const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

/**
 * A response with a failure status that the circuit breaker or retry loop
 * must see as an error. Carries the parsed response, which execute()
 * returns once retries are exhausted.
 */
class HttpStatusFailure extends ToolExecutionError {
  constructor(status: number, readonly output: TransportOutput, retryable: boolean) {
    const mapped = httpStatusToError(status, output.content);
    super(mapped.message, { code: mapped.code, statusCode: status, retryable });
    this.name = 'HttpStatusFailure';
  }
}

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
    const finish = (output: TransportOutput): TransportOutput => {
      output.metadata = {
        ...output.metadata,
        durationMs: Date.now() - startTime,
        circuitState: this.circuitBreaker?.getState(),
      };
      return output;
    };

    try {
      return finish(await this.executeWithMiddleware(await this.withBufferedFiles(input)));
    } catch (err) {
      if (err instanceof HttpStatusFailure) {
        // The server answered; return what it said, marked as an error.
        return finish({
          ...err.output,
          isError: true,
          metadata: { ...err.output.metadata, error: err.message, code: err.code },
        });
      }
      return finish(errorToOutput(err));
    }
  }

  async *executeStream(input: TransportInput): AsyncGenerator<TransportOutput> {
    const startTime = Date.now();

    try {
      const buffered = await this.withBufferedFiles(input);
      const { url, method, headers, body } = this.buildRequest(buffered);

      headers['Accept'] = 'text/event-stream';

      const timeoutMs = input.timeoutMs ?? this.config.timeoutMs ?? 30_000;
      const response = await withTimeout(
        async (signal) => {
          // Token acquisition counts against the timeout too.
          if (this.config.auth) await this.config.auth.apply(headers);
          return this.pool.request(url, method, headers, body, signal);
        },
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
    const retry = this.config.retry;
    const method = this.buildRequest(input).method;
    const keyHeader = retry?.idempotencyKeyHeader ?? 'Idempotency-Key';
    const callerKey = headerValue(input.headers, keyHeader);
    const idempotent = IDEMPOTENT_METHODS.has(method) || callerKey !== undefined;
    // Never repeat a call that may have side effects unless the caller
    // opted in — and then with one idempotency key for every attempt.
    const retrying = retry !== undefined && retry.maxRetries > 0 && (idempotent || retry.retryNonIdempotent === true);
    const idempotencyKey = retrying && !idempotent ? randomUUID() : undefined;
    const retryableStatuses = retry?.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;

    const doRequest = async (attempt: number): Promise<TransportOutput> => {
      const innerFn = async (): Promise<TransportOutput> => {
        const { url, method, headers, body } = this.buildRequest(input);
        if (idempotencyKey) headers[keyHeader] = idempotencyKey;

        const timeoutMs = input.timeoutMs ?? this.config.timeoutMs ?? 30_000;
        const response = await withTimeout(
          async (signal) => {
            // Token acquisition counts against the timeout too.
            if (this.config.auth) await this.config.auth.apply(headers);
            return this.pool.request(url, method, headers, body, signal);
          },
          timeoutMs,
          input.signal,
        );

        const output = await parseOutput(response);
        output.metadata = { ...output.metadata, attempt };

        // 5xx is a failure of the service (circuit breaker); a retryable
        // status is a failure of this attempt (retry loop).
        if (!response.ok) {
          const retryableStatus = retrying && retryableStatuses.includes(response.status);
          if (response.status >= 500 || retryableStatus) {
            throw new HttpStatusFailure(response.status, output, retryableStatus);
          }
        }

        return output;
      };

      // Wrap with circuit breaker if configured
      if (this.circuitBreaker) {
        return this.circuitBreaker.execute(innerFn);
      }
      return innerFn();
    };

    if (retrying) {
      return withRetry(doRequest, retry, input.signal);
    }
    return doRequest(0);
  }

  /** The input with every streamed upload read into a Buffer (capped). */
  private async withBufferedFiles(input: TransportInput): Promise<TransportInput> {
    if (!requiresMultipart(input.files)) return input;
    const files: FileUpload[] = await bufferFileUploads(input.files!, this.config.maxUploadBytes);
    return { ...input, files };
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

/** A header's value from a case-insensitive lookup, or undefined. */
function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
