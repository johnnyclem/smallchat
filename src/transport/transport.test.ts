import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// ITransport interface & types
// ---------------------------------------------------------------------------
import type { ITransport, TransportInput, TransportOutput } from './types.js';

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Auth strategies
// ---------------------------------------------------------------------------
import { BearerTokenAuth } from './auth.js';

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------
import { withRetry, calculateDelay } from './retry.js';

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
import { CircuitBreaker } from './circuit-breaker.js';

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
import { serializeInput } from './serialization.js';

// ---------------------------------------------------------------------------
// MCP protocol
// ---------------------------------------------------------------------------
import {
  buildToolCallRequest,
  buildInitializeRequest,
  buildToolsListRequest,
  buildInitializedNotification,
  parseJsonRpcResponse,
  parseStdioMessages,
  encodeStdioMessage,
  resetRequestIdCounter,
} from './mcp-protocol.js';

// ---------------------------------------------------------------------------
// Local transport
// ---------------------------------------------------------------------------
import { LocalTransport } from './local-transport.js';

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------
import { ConnectionPool } from './connection-pool.js';

// ---------------------------------------------------------------------------
// OpenAPI generator
// ---------------------------------------------------------------------------
import { generateFromOpenAPI, openAPIToToolDefinitions } from './openapi-generator.js';

// ---------------------------------------------------------------------------
// Postman importer
// ---------------------------------------------------------------------------
import { importPostmanCollection, postmanToToolDefinitions, parsePostmanCollection } from './postman-importer.js';

// ===========================================================================
// Tests
// ===========================================================================

describe('ITransport interface', () => {
  it('can be implemented by a simple mock', async () => {
    const mockTransport: ITransport = {
      id: 'mock-1',
      type: 'local',
      async execute(input: TransportInput): Promise<TransportOutput> {
        return {
          content: { echoed: input.args },
          isError: false,
        };
      },
    };

    const result = await mockTransport.execute({ toolName: 'test', args: { foo: 'bar' } });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ echoed: { foo: 'bar' } });
  });

  it('supports optional executeStream', async () => {
    const streamTransport: ITransport = {
      id: 'stream-1',
      type: 'http',
      async execute(): Promise<TransportOutput> {
        return { content: null, isError: false };
      },
      async *executeStream(input: TransportInput): AsyncGenerator<TransportOutput> {
        yield { content: 'chunk1', isError: false };
        yield { content: 'chunk2', isError: false };
      },
    };

    const chunks: TransportOutput[] = [];
    for await (const chunk of streamTransport.executeStream!({ toolName: 'test', args: {} })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('chunk1');
  });
});

describe('ToolExecutionError', () => {
  it('creates error with code and retryable flag', () => {
    const err = new ToolExecutionError('test error', {
      code: 'TEST',
      statusCode: 500,
      retryable: true,
    });
    expect(err.message).toBe('test error');
    expect(err.code).toBe('TEST');
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('ToolExecutionError');
  });

  it('TransportTimeoutError is retryable', () => {
    const err = new TransportTimeoutError(5000);
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('TRANSPORT_TIMEOUT');
  });

  it('CircuitOpenError is not retryable', () => {
    const err = new CircuitOpenError('transport-1');
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('CIRCUIT_OPEN');
  });

  it('SandboxError is not retryable', () => {
    const err = new SandboxError('timeout');
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('SANDBOX_VIOLATION');
  });
});

describe('httpStatusToError', () => {
  it('maps 500 to retryable INTERNAL_SERVER_ERROR', () => {
    const err = httpStatusToError(500);
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(500);
  });

  it('maps 404 to non-retryable NOT_FOUND', () => {
    const err = httpStatusToError(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.retryable).toBe(false);
  });

  it('maps 429 to retryable RATE_LIMITED', () => {
    const err = httpStatusToError(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
  });

  it('maps unknown status codes', () => {
    const err = httpStatusToError(418);
    expect(err.code).toBe('HTTP_418');
    expect(err.retryable).toBe(false);
  });
});

describe('jsonRpcErrorToError', () => {
  it('maps parse error', () => {
    const err = jsonRpcErrorToError(-32700, 'Parse error');
    expect(err.code).toBe('PARSE_ERROR');
    expect(err.retryable).toBe(false);
  });

  it('maps internal error as retryable', () => {
    const err = jsonRpcErrorToError(-32603, 'Internal error');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.retryable).toBe(true);
  });
});

describe('errorToOutput', () => {
  it('converts ToolExecutionError to TransportOutput', () => {
    const err = new ToolExecutionError('test', { code: 'TEST', statusCode: 400 });
    const output = errorToOutput(err);
    expect(output.isError).toBe(true);
    expect(output.metadata?.error).toBe('test');
    expect(output.metadata?.errorCode).toBe(400);
  });

  it('converts generic errors', () => {
    const output = errorToOutput(new Error('generic'));
    expect(output.isError).toBe(true);
    expect(output.metadata?.error).toBe('generic');
  });

  it('converts non-error values', () => {
    const output = errorToOutput('string error');
    expect(output.isError).toBe(true);
  });
});

describe('isRetryable', () => {
  it('returns true for retryable ToolExecutionError', () => {
    expect(isRetryable(new ToolExecutionError('test', { code: 'TEST', retryable: true }))).toBe(true);
  });

  it('returns false for non-retryable ToolExecutionError', () => {
    expect(isRetryable(new ToolExecutionError('test', { code: 'TEST', retryable: false }))).toBe(false);
  });

  it('returns false for generic errors', () => {
    expect(isRetryable(new Error('test'))).toBe(false);
  });
});

describe('BearerTokenAuth', () => {
  it('injects Authorization header', async () => {
    const auth = new BearerTokenAuth({ token: 'my-token-123' });
    const headers: Record<string, string> = {};
    await auth.apply(headers);
    expect(headers['Authorization']).toBe('Bearer my-token-123');
  });

  it('can update the token', async () => {
    const auth = new BearerTokenAuth({ token: 'old' });
    auth.setToken('new');
    const headers: Record<string, string> = {};
    await auth.apply(headers);
    expect(headers['Authorization']).toBe('Bearer new');
  });

  it('exposes the current token', () => {
    const auth = new BearerTokenAuth({ token: 'abc' });
    expect(auth.getToken()).toBe('abc');
  });
});

describe('withRetry', () => {
  it('returns on first success', async () => {
    const result = await withRetry(async () => 'ok', { maxRetries: 3 });
    expect(result).toBe('ok');
  });

  it('retries on retryable errors', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new ToolExecutionError('fail', { code: 'TEST', retryable: true });
      return 'ok';
    }, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws immediately on non-retryable errors', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new ToolExecutionError('fail', { code: 'TEST', retryable: false });
    }, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('fail');
    expect(attempts).toBe(1);
  });

  it('throws after max retries exhausted', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new ToolExecutionError('fail', { code: 'TEST', retryable: true });
    }, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow('fail');
    expect(attempts).toBe(3); // initial + 2 retries
  });
});

describe('calculateDelay', () => {
  it('applies exponential backoff', () => {
    const d0 = calculateDelay(0, 1000, 30000, 0);
    const d1 = calculateDelay(1, 1000, 30000, 0);
    const d2 = calculateDelay(2, 1000, 30000, 0);
    expect(d0).toBe(1000);
    expect(d1).toBe(2000);
    expect(d2).toBe(4000);
  });

  it('caps at maxDelay', () => {
    const delay = calculateDelay(10, 1000, 5000, 0);
    expect(delay).toBe(5000);
  });
});

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', { failureThreshold: 3, resetTimeoutMs: 100, successThreshold: 1 });
  });

  it('starts in closed state', () => {
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after failure threshold', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(breaker.getState()).toBe('open');
  });

  it('rejects calls when open', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    await expect(breaker.execute(() => Promise.resolve('ok'))).rejects.toThrow(CircuitOpenError);
  });

  it('transitions to half-open after timeout', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(breaker.getState()).toBe('open');

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 150));
    expect(breaker.getState()).toBe('half-open');
  });

  it('closes after successful probe in half-open', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 150));

    const result = await breaker.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('closed');
  });

  it('resets to clean state', () => {
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getFailureCount()).toBe(2);
    breaker.reset();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getFailureCount()).toBe(0);
  });
});

describe('serializeInput', () => {
  it('serializes body for POST without route', () => {
    const result = serializeInput('https://api.example.com', { name: 'test', value: 42 }, {
      toolName: 'create',
      method: 'POST',
      path: 'items',
    });
    expect(result.url).toBe('https://api.example.com/items');
    expect(result.method).toBe('POST');
    expect(JSON.parse(result.body!)).toEqual({ name: 'test', value: 42 });
    expect(result.headers['Content-Type']).toBe('application/json');
  });

  it('serializes query params for GET', () => {
    const result = serializeInput('https://api.example.com', { q: 'hello', limit: 10 }, {
      toolName: 'search',
      method: 'GET',
      path: 'search',
      queryParams: ['q', 'limit'],
    });
    expect(result.url).toContain('q=hello');
    expect(result.url).toContain('limit=10');
    expect(result.body).toBeNull();
  });

  it('interpolates path params', () => {
    const result = serializeInput('https://api.example.com', { id: '123', name: 'test' }, {
      toolName: 'getUser',
      method: 'GET',
      path: 'users/{id}',
      pathParams: ['id'],
    });
    expect(result.url).toBe('https://api.example.com/users/123');
  });

  it('separates path, query, and body params', () => {
    const result = serializeInput('https://api.example.com', {
      id: '123',
      q: 'search',
      name: 'update',
    }, {
      toolName: 'updateUser',
      method: 'PUT',
      path: 'users/{id}',
      pathParams: ['id'],
      queryParams: ['q'],
    });
    expect(result.url).toContain('users/123');
    expect(result.url).toContain('q=search');
    const body = JSON.parse(result.body!);
    expect(body).toEqual({ name: 'update' });
    expect(body.id).toBeUndefined();
    expect(body.q).toBeUndefined();
  });

  it('strips trailing slash from base URL', () => {
    const result = serializeInput('https://api.example.com/', { x: 1 }, {
      toolName: 'test',
      method: 'POST',
      path: 'endpoint',
    });
    expect(result.url).toBe('https://api.example.com/endpoint');
  });
});

describe('MCP Protocol', () => {
  beforeEach(() => {
    resetRequestIdCounter();
  });

  it('builds initialize request', () => {
    const req = buildInitializeRequest();
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('initialize');
    expect(req.id).toBe(1);
    expect(req.params).toBeDefined();
  });

  it('builds initialized notification', () => {
    const notif = buildInitializedNotification();
    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe('notifications/initialized');
    expect('id' in notif).toBe(false);
  });

  it('builds tools/list request', () => {
    const req = buildToolsListRequest();
    expect(req.method).toBe('tools/list');
  });

  it('builds tools/call request', () => {
    const req = buildToolCallRequest('myTool', { arg1: 'value1' });
    expect(req.method).toBe('tools/call');
    expect(req.params).toEqual({ name: 'myTool', arguments: { arg1: 'value1' } });
  });

  it('parses successful JSON-RPC response', () => {
    const result = parseJsonRpcResponse<{ data: string }>({
      jsonrpc: '2.0',
      id: 1,
      result: { data: 'hello' },
    });
    expect(result).toEqual({ data: 'hello' });
  });

  it('throws on JSON-RPC error response', () => {
    expect(() => parseJsonRpcResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    })).toThrow(ToolExecutionError);
  });

  it('throws on invalid response', () => {
    expect(() => parseJsonRpcResponse({ invalid: true })).toThrow('Invalid JSON-RPC response');
  });

  it('parses stdio messages', () => {
    const buffer = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n{"jsonrpc":"2.0","id":2,"result":{"ok":false}}\n';
    const { messages, remaining } = parseStdioMessages(buffer);
    expect(messages).toHaveLength(2);
    expect(remaining).toBe('');
  });

  it('handles incomplete stdio messages', () => {
    const buffer = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n{"jsonrpc":"2.0","id';
    const { messages, remaining } = parseStdioMessages(buffer);
    expect(messages).toHaveLength(1);
    expect(remaining).toBe('{"jsonrpc":"2.0","id');
  });

  it('encodes stdio messages with newline', () => {
    const msg = encodeStdioMessage({ jsonrpc: '2.0', id: 1, method: 'test' });
    expect(msg.endsWith('\n')).toBe(true);
    expect(JSON.parse(msg)).toEqual({ jsonrpc: '2.0', id: 1, method: 'test' });
  });
});

describe('LocalTransport', () => {
  it('executes a registered handler', async () => {
    const transport = new LocalTransport();
    transport.registerHandler('echo', async (args) => ({
      content: { echoed: args },
      isError: false,
    }));

    const result = await transport.execute({ toolName: 'echo', args: { msg: 'hello' } });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ echoed: { msg: 'hello' } });
    expect(result.metadata?.durationMs).toBeTypeOf('number');
  });

  it('returns error for unregistered handler', async () => {
    const transport = new LocalTransport();
    const result = await transport.execute({ toolName: 'unknown', args: {} });
    expect(result.isError).toBe(true);
    expect(result.metadata?.error).toContain('No local handler registered');
  });

  it('handles handler errors gracefully', async () => {
    const transport = new LocalTransport();
    transport.registerHandler('failing', async () => {
      throw new Error('Handler crashed');
    });

    const result = await transport.execute({ toolName: 'failing', args: {} });
    expect(result.isError).toBe(true);
    expect(result.metadata?.error).toContain('Handler crashed');
  });

  it('supports handler registration and removal', () => {
    const transport = new LocalTransport();
    transport.registerHandler('test', async () => ({ content: null }));
    expect(transport.hasHandler('test')).toBe(true);

    transport.unregisterHandler('test');
    expect(transport.hasHandler('test')).toBe(false);
  });

  it('can be initialized with handlers map', async () => {
    const handlers = new Map();
    handlers.set('greet', async () => ({ content: 'hello', isError: false }));

    const transport = new LocalTransport({ handlers });
    const result = await transport.execute({ toolName: 'greet', args: {} });
    expect(result.content).toBe('hello');
  });

  it('disposes by clearing handlers', async () => {
    const transport = new LocalTransport();
    transport.registerHandler('test', async () => ({ content: null }));
    await transport.dispose();
    expect(transport.hasHandler('test')).toBe(false);
  });
});

describe('ConnectionPool', () => {
  it('tracks active connections', () => {
    const pool = new ConnectionPool({ maxConnections: 5 });
    expect(pool.getActiveConnections()).toBe(0);
    expect(pool.getQueuedRequests()).toBe(0);
  });

  it('disposes cleanly', async () => {
    const pool = new ConnectionPool();
    pool.dispose();
    await expect(pool.fetch('http://example.com')).rejects.toThrow('disposed');
  });
});

describe('OpenAPI Generator', () => {
  const minimalSpec = {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0.0' },
    servers: [{ url: 'https://api.test.com' }],
    paths: {
      '/users': {
        get: {
          operationId: 'listUsers',
          summary: 'List all users',
          parameters: [
            { name: 'limit', in: 'query' as const, schema: { type: 'integer' } },
          ],
        },
        post: {
          operationId: 'createUser',
          summary: 'Create a user',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    email: { type: 'string' },
                  },
                  required: ['name', 'email'],
                },
              },
            },
          },
        },
      },
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          summary: 'Get a user',
          parameters: [
            { name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } },
          ],
        },
        delete: {
          operationId: 'deleteUser',
          summary: 'Delete a user',
          parameters: [
            { name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } },
          ],
        },
      },
    },
  };

  it('generates routes from OpenAPI spec', () => {
    const config = generateFromOpenAPI(minimalSpec);
    expect(config.baseUrl).toBe('https://api.test.com');
    expect(config.routes).toHaveLength(4);

    const listUsers = config.routes.find(r => r.toolName === 'listUsers');
    expect(listUsers).toBeDefined();
    expect(listUsers!.method).toBe('GET');
    expect(listUsers!.path).toBe('/users');
    expect(listUsers!.queryParams).toContain('limit');

    const createUser = config.routes.find(r => r.toolName === 'createUser');
    expect(createUser).toBeDefined();
    expect(createUser!.method).toBe('POST');
    expect(createUser!.bodyParams).toContain('name');
    expect(createUser!.bodyParams).toContain('email');

    const getUser = config.routes.find(r => r.toolName === 'getUser');
    expect(getUser).toBeDefined();
    expect(getUser!.pathParams).toContain('id');

    const deleteUser = config.routes.find(r => r.toolName === 'deleteUser');
    expect(deleteUser).toBeDefined();
    expect(deleteUser!.method).toBe('DELETE');
  });

  it('overrides base URL', () => {
    const config = generateFromOpenAPI(minimalSpec, { baseUrl: 'http://localhost:8080' });
    expect(config.baseUrl).toBe('http://localhost:8080');
  });

  it('generates ToolDefinitions for the compiler', () => {
    const tools = openAPIToToolDefinitions(minimalSpec, 'test-provider');
    expect(tools.length).toBeGreaterThanOrEqual(4);

    const listUsers = tools.find(t => t.name === 'listUsers');
    expect(listUsers).toBeDefined();
    expect(listUsers!.providerId).toBe('test-provider');
    expect(listUsers!.transportType).toBe('rest');
    expect(listUsers!.inputSchema.properties).toHaveProperty('limit');
  });

  it('applies bearer token auth', () => {
    const config = generateFromOpenAPI(minimalSpec, {
      auth: { bearerToken: 'test-token' },
    });
    expect(config.auth).toBeDefined();
  });
});

describe('Postman Importer', () => {
  const minimalCollection = {
    info: {
      name: 'Test Collection',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Get Users',
        request: {
          method: 'GET',
          url: {
            raw: 'https://api.test.com/users?limit=10',
            protocol: 'https',
            host: ['api', 'test', 'com'],
            path: ['users'],
            query: [{ key: 'limit', value: '10' }],
          },
        },
      },
      {
        name: 'Create User',
        request: {
          method: 'POST',
          url: {
            raw: 'https://api.test.com/users',
            protocol: 'https',
            host: ['api', 'test', 'com'],
            path: ['users'],
          },
          body: {
            mode: 'raw' as const,
            raw: '{"name": "John", "email": "john@test.com"}',
          },
        },
      },
      {
        name: 'User Operations',
        item: [
          {
            name: 'Delete User',
            request: {
              method: 'DELETE',
              url: {
                raw: 'https://api.test.com/users/:id',
                protocol: 'https',
                host: ['api', 'test', 'com'],
                path: ['users', ':id'],
              },
            },
          },
        ],
      },
    ],
    variable: [
      { key: 'baseUrl', value: 'https://api.test.com' },
    ],
  };

  it('imports routes from Postman collection', () => {
    const config = importPostmanCollection(minimalCollection);
    expect(config.baseUrl).toBe('https://api.test.com');
    expect(config.routes).toHaveLength(3);

    const getUsers = config.routes.find(r => r.toolName === 'get_users');
    expect(getUsers).toBeDefined();
    expect(getUsers!.method).toBe('GET');
    expect(getUsers!.queryParams).toContain('limit');

    const createUser = config.routes.find(r => r.toolName === 'create_user');
    expect(createUser).toBeDefined();
    expect(createUser!.method).toBe('POST');
    expect(createUser!.bodyParams).toContain('name');
  });

  it('handles nested folders', () => {
    const config = importPostmanCollection(minimalCollection);
    // Folder path is "User Operations/Delete User" → sanitized
    const deleteUser = config.routes.find(r => r.toolName.includes('delete_user'));
    expect(deleteUser).toBeDefined();
    expect(deleteUser!.method).toBe('DELETE');
    expect(deleteUser!.pathParams).toContain('id');
  });

  it('generates ToolDefinitions', () => {
    const tools = postmanToToolDefinitions(minimalCollection, 'postman-test');
    expect(tools.length).toBeGreaterThanOrEqual(3);
    expect(tools[0].providerId).toBe('postman-test');
    expect(tools[0].transportType).toBe('rest');
  });

  it('parses collection JSON', () => {
    const json = JSON.stringify(minimalCollection);
    const parsed = parsePostmanCollection(json);
    expect(parsed.info.name).toBe('Test Collection');
  });

  it('rejects invalid collection format', () => {
    expect(() => parsePostmanCollection('{"info":{"name":"bad","schema":"invalid"}}')).toThrow('Invalid Postman Collection');
  });
});

describe('HttpTransport', () => {
  // HttpTransport integration tests would require a running HTTP server.
  // We test the components it uses instead (serialization, retry, circuit breaker).
  // See above tests for those components.

  it('module can be imported', async () => {
    const { HttpTransport } = await import('./http-transport.js');
    const transport = new HttpTransport({ baseUrl: 'http://localhost:9999' });
    expect(transport.id).toMatch(/^http-/);
    expect(transport.type).toBe('http');
    await transport.dispose();
  });
});

describe('McpStdioTransport', () => {
  it('module can be imported', async () => {
    const { McpStdioTransport } = await import('./mcp-client-transport.js');
    const transport = new McpStdioTransport({ command: 'echo' });
    expect(transport.id).toMatch(/^mcp-stdio-/);
    expect(transport.type).toBe('mcp-stdio');
    await transport.dispose();
  });
});

describe('McpSseTransport', () => {
  it('module can be imported', async () => {
    const { McpSseTransport } = await import('./mcp-client-transport.js');
    const transport = new McpSseTransport({ url: 'http://localhost:9999/sse' });
    expect(transport.id).toMatch(/^mcp-sse-/);
    expect(transport.type).toBe('mcp-sse');
  });
});
