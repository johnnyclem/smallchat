/**
 * Feature: Transport Error Handling
 *
 * Standardized error mapping from protocol-specific errors (HTTP status codes,
 * JSON-RPC error codes) to a unified ToolExecutionError hierarchy.
 */

import { describe, it, expect } from 'vitest';
import {
  ToolExecutionError,
  TransportTimeoutError,
  CircuitOpenError,
  SandboxError,
  httpStatusToError,
  jsonRpcErrorToError,
  errorToOutput,
  isRetryable,
} from './errors.js';

describe('Feature: Transport Error Classes', () => {
  describe('Scenario: ToolExecutionError construction', () => {
    it('Given error options, When a ToolExecutionError is created, Then all properties are set correctly', () => {
      const err = new ToolExecutionError('Test error', {
        code: 'TEST_CODE',
        statusCode: 500,
        retryable: true,
        metadata: { detail: 'extra' },
      });

      expect(err.message).toBe('Test error');
      expect(err.name).toBe('ToolExecutionError');
      expect(err.code).toBe('TEST_CODE');
      expect(err.statusCode).toBe(500);
      expect(err.retryable).toBe(true);
      expect(err.metadata).toEqual({ detail: 'extra' });
    });

    it('Given no retryable flag, When a ToolExecutionError is created, Then retryable defaults to false', () => {
      const err = new ToolExecutionError('Test', { code: 'TEST' });
      expect(err.retryable).toBe(false);
    });

    it('Given a cause error, When a ToolExecutionError is created, Then cause is preserved', () => {
      const cause = new Error('root cause');
      const err = new ToolExecutionError('Wrapper', { code: 'WRAP', cause });
      expect(err.cause).toBe(cause);
    });
  });

  describe('Scenario: TransportTimeoutError', () => {
    it('Given a timeout value, When TransportTimeoutError is created, Then it has correct properties', () => {
      const err = new TransportTimeoutError(5000);

      expect(err.name).toBe('TransportTimeoutError');
      expect(err.message).toContain('5000ms');
      expect(err.code).toBe('TRANSPORT_TIMEOUT');
      expect(err.statusCode).toBe(408);
      expect(err.retryable).toBe(true);
    });
  });

  describe('Scenario: CircuitOpenError', () => {
    it('Given a transport ID, When CircuitOpenError is created, Then it contains the transport ID', () => {
      const err = new CircuitOpenError('my-transport');

      expect(err.name).toBe('CircuitOpenError');
      expect(err.message).toContain('my-transport');
      expect(err.code).toBe('CIRCUIT_OPEN');
      expect(err.retryable).toBe(false);
    });
  });

  describe('Scenario: SandboxError', () => {
    it('Given a sandbox violation, When SandboxError is created, Then it is non-retryable', () => {
      const err = new SandboxError('Module "fs" is not allowed');

      expect(err.name).toBe('SandboxError');
      expect(err.code).toBe('SANDBOX_VIOLATION');
      expect(err.retryable).toBe(false);
    });
  });
});

describe('Feature: HTTP Status to Error Mapping', () => {
  describe('Scenario: Known HTTP status codes are mapped correctly', () => {
    it.each([
      [400, 'BAD_REQUEST', false],
      [401, 'UNAUTHORIZED', false],
      [403, 'FORBIDDEN', false],
      [404, 'NOT_FOUND', false],
      [408, 'REQUEST_TIMEOUT', true],
      [429, 'RATE_LIMITED', true],
      [500, 'INTERNAL_SERVER_ERROR', true],
      [502, 'BAD_GATEWAY', true],
      [503, 'SERVICE_UNAVAILABLE', true],
      [504, 'GATEWAY_TIMEOUT', true],
    ])('Given HTTP %i, When httpStatusToError is called, Then code is %s and retryable is %s', (status, expectedCode, expectedRetryable) => {
      const err = httpStatusToError(status);
      expect(err.code).toBe(expectedCode);
      expect(err.statusCode).toBe(status);
      expect(err.retryable).toBe(expectedRetryable);
    });
  });

  describe('Scenario: Unknown HTTP status codes', () => {
    it('Given an unknown 5xx status, When httpStatusToError is called, Then it is retryable', () => {
      const err = httpStatusToError(599);
      expect(err.code).toBe('HTTP_599');
      expect(err.retryable).toBe(true);
    });

    it('Given an unknown 4xx status, When httpStatusToError is called, Then it is not retryable', () => {
      const err = httpStatusToError(418);
      expect(err.code).toBe('HTTP_418');
      expect(err.retryable).toBe(false);
    });
  });

  describe('Scenario: Error body is included in metadata', () => {
    it('Given a body, When httpStatusToError is called, Then body appears in metadata', () => {
      const err = httpStatusToError(400, { detail: 'bad input' });
      expect(err.metadata).toEqual({ body: { detail: 'bad input' } });
    });

    it('Given no body, When httpStatusToError is called, Then metadata is undefined', () => {
      const err = httpStatusToError(400);
      expect(err.metadata).toBeUndefined();
    });
  });
});

describe('Feature: JSON-RPC Error Code Mapping', () => {
  describe('Scenario: Standard JSON-RPC error codes', () => {
    it.each([
      [-32700, 'PARSE_ERROR', false],
      [-32600, 'INVALID_REQUEST', false],
      [-32601, 'METHOD_NOT_FOUND', false],
      [-32602, 'INVALID_PARAMS', false],
      [-32603, 'INTERNAL_ERROR', true],
    ])('Given JSON-RPC code %i, When jsonRpcErrorToError is called, Then code is %s', (code, expectedCode, expectedRetryable) => {
      const err = jsonRpcErrorToError(code, 'test message');
      expect(err.code).toBe(expectedCode);
      expect(err.retryable).toBe(expectedRetryable);
    });
  });

  describe('Scenario: Unknown JSON-RPC error code', () => {
    it('Given an unknown code <= -32000, When jsonRpcErrorToError is called, Then it is retryable', () => {
      const err = jsonRpcErrorToError(-32099, 'custom error');
      expect(err.code).toBe('JSONRPC_-32099');
      expect(err.retryable).toBe(true);
    });

    it('Given an unknown code > -32000, When jsonRpcErrorToError is called, Then it is not retryable', () => {
      const err = jsonRpcErrorToError(-1000, 'app error');
      expect(err.code).toBe('JSONRPC_-1000');
      expect(err.retryable).toBe(false);
    });
  });
});

describe('Feature: Error to TransportOutput Conversion', () => {
  describe('Scenario: ToolExecutionError is converted with full metadata', () => {
    it('Given a ToolExecutionError, When errorToOutput is called, Then output contains error details', () => {
      const err = new ToolExecutionError('fail', {
        code: 'TEST',
        statusCode: 500,
        retryable: true,
        metadata: { extra: 'data' },
      });

      const output = errorToOutput(err);

      expect(output.content).toBeNull();
      expect(output.isError).toBe(true);
      expect(output.metadata?.error).toBe('fail');
      expect(output.metadata?.code).toBe('TEST');
      expect(output.metadata?.retryable).toBe(true);
      expect(output.metadata?.extra).toBe('data');
    });
  });

  describe('Scenario: Regular Error is converted', () => {
    it('Given a regular Error, When errorToOutput is called, Then output has UNKNOWN_ERROR code', () => {
      const output = errorToOutput(new Error('oops'));

      expect(output.isError).toBe(true);
      expect(output.metadata?.error).toBe('oops');
      expect(output.metadata?.code).toBe('UNKNOWN_ERROR');
    });
  });

  describe('Scenario: Non-Error value is converted', () => {
    it('Given a string, When errorToOutput is called, Then it is stringified', () => {
      const output = errorToOutput('string error');

      expect(output.isError).toBe(true);
      expect(output.metadata?.error).toBe('string error');
    });
  });
});

describe('Feature: Retryable Error Detection', () => {
  describe('Scenario: ToolExecutionError retryable flag', () => {
    it('Given a retryable ToolExecutionError, When isRetryable is called, Then it returns true', () => {
      const err = new ToolExecutionError('test', { code: 'T', retryable: true });
      expect(isRetryable(err)).toBe(true);
    });

    it('Given a non-retryable ToolExecutionError, When isRetryable is called, Then it returns false', () => {
      const err = new ToolExecutionError('test', { code: 'T', retryable: false });
      expect(isRetryable(err)).toBe(false);
    });
  });

  describe('Scenario: Network errors are retryable', () => {
    it('Given a TypeError with fetch in message, When isRetryable is called, Then it returns true', () => {
      expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    });

    it('Given a TypeError with network in message, When isRetryable is called, Then it returns true', () => {
      expect(isRetryable(new TypeError('network error'))).toBe(true);
    });
  });

  describe('Scenario: Other errors are not retryable', () => {
    it('Given a generic Error, When isRetryable is called, Then it returns false', () => {
      expect(isRetryable(new Error('random'))).toBe(false);
    });

    it('Given a non-error value, When isRetryable is called, Then it returns false', () => {
      expect(isRetryable('string')).toBe(false);
    });
  });
});
