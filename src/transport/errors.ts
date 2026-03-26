/**
 * Transport Error Handling — standardized error mapping.
 *
 * Maps protocol-specific errors (HTTP status codes, JSON-RPC error codes,
 * process exit codes) to a unified ToolExecutionError hierarchy.
 */

import type { TransportOutput } from './types.js';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Base error for all transport-level failures.
 */
export class ToolExecutionError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly metadata?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: string;
      statusCode?: number;
      retryable?: boolean;
      metadata?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ToolExecutionError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.metadata = options.metadata;
  }
}

/**
 * Timeout error — the transport did not respond within the configured timeout.
 */
export class TransportTimeoutError extends ToolExecutionError {
  constructor(timeoutMs: number, options?: { cause?: Error }) {
    super(`Transport timed out after ${timeoutMs}ms`, {
      code: 'TRANSPORT_TIMEOUT',
      statusCode: 408,
      retryable: true,
      cause: options?.cause,
    });
    this.name = 'TransportTimeoutError';
  }
}

/**
 * Circuit breaker open — the transport is refusing calls due to repeated failures.
 */
export class CircuitOpenError extends ToolExecutionError {
  constructor(transportId: string) {
    super(`Circuit breaker open for transport ${transportId}`, {
      code: 'CIRCUIT_OPEN',
      retryable: false,
    });
    this.name = 'CircuitOpenError';
  }
}

/**
 * Sandbox violation — the local function exceeded its sandbox constraints.
 */
export class SandboxError extends ToolExecutionError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, {
      code: 'SANDBOX_VIOLATION',
      retryable: false,
      cause: options?.cause,
    });
    this.name = 'SandboxError';
  }
}

/**
 * Container sandbox error — Docker container spawning or execution failed.
 */
export class ContainerSandboxError extends ToolExecutionError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, {
      code: 'CONTAINER_SANDBOX_ERROR',
      retryable: false,
      cause: options?.cause,
    });
    this.name = 'ContainerSandboxError';
  }
}

// ---------------------------------------------------------------------------
// HTTP status → error mapping
// ---------------------------------------------------------------------------

const HTTP_ERROR_MAP: Record<number, { code: string; retryable: boolean }> = {
  400: { code: 'BAD_REQUEST', retryable: false },
  401: { code: 'UNAUTHORIZED', retryable: false },
  403: { code: 'FORBIDDEN', retryable: false },
  404: { code: 'NOT_FOUND', retryable: false },
  405: { code: 'METHOD_NOT_ALLOWED', retryable: false },
  408: { code: 'REQUEST_TIMEOUT', retryable: true },
  409: { code: 'CONFLICT', retryable: false },
  422: { code: 'UNPROCESSABLE_ENTITY', retryable: false },
  429: { code: 'RATE_LIMITED', retryable: true },
  500: { code: 'INTERNAL_SERVER_ERROR', retryable: true },
  502: { code: 'BAD_GATEWAY', retryable: true },
  503: { code: 'SERVICE_UNAVAILABLE', retryable: true },
  504: { code: 'GATEWAY_TIMEOUT', retryable: true },
};

/** Map an HTTP status code to a ToolExecutionError */
export function httpStatusToError(
  status: number,
  body?: unknown,
): ToolExecutionError {
  const mapping = HTTP_ERROR_MAP[status] ?? {
    code: `HTTP_${status}`,
    retryable: status >= 500,
  };

  return new ToolExecutionError(
    `HTTP ${status}: ${mapping.code}`,
    {
      code: mapping.code,
      statusCode: status,
      retryable: mapping.retryable,
      metadata: body != null ? { body } : undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// JSON-RPC error code → error mapping
// ---------------------------------------------------------------------------

const JSONRPC_ERROR_MAP: Record<number, { code: string; retryable: boolean }> = {
  [-32700]: { code: 'PARSE_ERROR', retryable: false },
  [-32600]: { code: 'INVALID_REQUEST', retryable: false },
  [-32601]: { code: 'METHOD_NOT_FOUND', retryable: false },
  [-32602]: { code: 'INVALID_PARAMS', retryable: false },
  [-32603]: { code: 'INTERNAL_ERROR', retryable: true },
};

/** Map a JSON-RPC error code to a ToolExecutionError */
export function jsonRpcErrorToError(
  code: number,
  message: string,
): ToolExecutionError {
  const mapping = JSONRPC_ERROR_MAP[code] ?? {
    code: `JSONRPC_${code}`,
    retryable: code <= -32000,
  };

  return new ToolExecutionError(
    `JSON-RPC ${code}: ${message}`,
    {
      code: mapping.code,
      statusCode: code,
      retryable: mapping.retryable,
    },
  );
}

// ---------------------------------------------------------------------------
// Error → TransportOutput conversion
// ---------------------------------------------------------------------------

/** Convert any error into a standardized TransportOutput */
export function errorToOutput(err: unknown): TransportOutput {
  if (err instanceof ToolExecutionError) {
    return {
      content: null,
      isError: true,
      metadata: {
        error: err.message,
        errorCode: err.statusCode,
        code: err.code,
        retryable: err.retryable,
        ...err.metadata,
      },
    };
  }

  const error = err instanceof Error ? err : new Error(String(err));
  return {
    content: null,
    isError: true,
    metadata: {
      error: error.message,
      code: 'UNKNOWN_ERROR',
    },
  };
}

/** Check if an error is retryable */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ToolExecutionError) return err.retryable;
  // Network errors are generally retryable
  if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network'))) {
    return true;
  }
  return false;
}
