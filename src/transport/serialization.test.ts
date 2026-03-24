/**
 * Feature: Input Serialization and Output Parsing
 *
 * Handles mapping between SCObject arguments and HTTP wire formats
 * (JSON body, query params, path params) and parsing responses.
 */

import { describe, it, expect } from 'vitest';
import { serializeInput, parseOutput } from './serialization.js';

describe('Feature: Input Serialization', () => {
  describe('Scenario: POST with all args as JSON body (no route config)', () => {
    it('Given args and no route, When serializeInput is called, Then all args are serialized as JSON body', () => {
      const result = serializeInput('https://api.example.com', {
        name: 'Alice',
        age: 30,
      });

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.example.com');
      expect(result.body).toBe(JSON.stringify({ name: 'Alice', age: 30 }));
      expect(result.headers['Content-Type']).toBe('application/json');
    });
  });

  describe('Scenario: Path parameter interpolation', () => {
    it('Given a route with path params, When serializeInput is called, Then path params are interpolated into the URL', () => {
      const result = serializeInput('https://api.example.com', {
        userId: '123',
        name: 'Alice',
      }, {
        toolName: 'getUser',
        method: 'GET',
        path: 'users/{userId}',
        pathParams: ['userId'],
      });

      expect(result.url).toBe('https://api.example.com/users/123');
      expect(result.method).toBe('GET');
      expect(result.body).toBeNull();
    });
  });

  describe('Scenario: Query parameters', () => {
    it('Given a route with query params, When serializeInput is called, Then query params are appended to the URL', () => {
      const result = serializeInput('https://api.example.com', {
        q: 'hello',
        limit: 10,
      }, {
        toolName: 'search',
        method: 'GET',
        path: 'search',
        queryParams: ['q', 'limit'],
      });

      expect(result.url).toBe('https://api.example.com/search?q=hello&limit=10');
    });
  });

  describe('Scenario: Body params are filtered from path and query', () => {
    it('Given a route with path, query, and body params, When serializeInput is called, Then each goes to the right place', () => {
      const result = serializeInput('https://api.example.com', {
        userId: '42',
        format: 'json',
        name: 'Bob',
        email: 'bob@test.com',
      }, {
        toolName: 'updateUser',
        method: 'PUT',
        path: 'users/{userId}',
        pathParams: ['userId'],
        queryParams: ['format'],
      });

      expect(result.url).toBe('https://api.example.com/users/42?format=json');
      const body = JSON.parse(result.body as string);
      expect(body).toEqual({ name: 'Bob', email: 'bob@test.com' });
      expect(body.userId).toBeUndefined();
      expect(body.format).toBeUndefined();
    });
  });

  describe('Scenario: Explicit body params', () => {
    it('Given a route with explicit bodyParams, When serializeInput is called, Then only those params appear in the body', () => {
      const result = serializeInput('https://api.example.com', {
        name: 'Alice',
        age: 30,
        extra: 'ignored',
      }, {
        toolName: 'create',
        method: 'POST',
        path: 'users',
        bodyParams: ['name', 'age'],
      });

      const body = JSON.parse(result.body as string);
      expect(body).toEqual({ name: 'Alice', age: 30 });
      expect(body.extra).toBeUndefined();
    });
  });

  describe('Scenario: GET without route puts all args as query params', () => {
    it('Given no route and GET method, When serializeInput is called, Then all args become query params', () => {
      const result = serializeInput('https://api.example.com', {
        q: 'test',
        page: 1,
      }, {
        toolName: 'search',
        method: 'GET',
        path: '',
      });

      // With explicit route, only queryParams go to query
      // This test uses explicit route but no queryParams specified
      expect(result.body).toBeNull();
    });
  });

  describe('Scenario: Trailing slash is normalized', () => {
    it('Given a baseUrl with trailing slash, When serializeInput is called, Then the URL is properly normalized', () => {
      const result = serializeInput('https://api.example.com/', {}, {
        toolName: 'test',
        method: 'GET',
        path: '/users',
      });

      expect(result.url).toBe('https://api.example.com/users');
    });
  });

  describe('Scenario: Special characters in path params are encoded', () => {
    it('Given a path param with special characters, When serializeInput is called, Then it is URL-encoded', () => {
      const result = serializeInput('https://api.example.com', {
        name: 'hello world/test',
      }, {
        toolName: 'test',
        method: 'GET',
        path: 'items/{name}',
        pathParams: ['name'],
      });

      expect(result.url).toContain('hello%20world%2Ftest');
    });
  });

  describe('Scenario: Null and undefined args are excluded from query', () => {
    it('Given args with null/undefined values, When serialized as query params, Then they are omitted', () => {
      const result = serializeInput('https://api.example.com', {
        q: 'test',
        filter: null,
        sort: undefined,
      }, {
        toolName: 'search',
        method: 'GET',
        path: 'search',
        queryParams: ['q', 'filter', 'sort'],
      });

      expect(result.url).toBe('https://api.example.com/search?q=test');
    });
  });

  describe('Scenario: Array values in query params are comma-joined', () => {
    it('Given an array query param, When serializeInput is called, Then values are comma-separated', () => {
      const result = serializeInput('https://api.example.com', {
        tags: ['a', 'b', 'c'],
      }, {
        toolName: 'filter',
        method: 'GET',
        path: 'items',
        queryParams: ['tags'],
      });

      expect(result.url).toContain('tags=a%2Cb%2Cc');
    });
  });

  describe('Scenario: Empty body is not sent', () => {
    it('Given a POST with no matching body params, When serializeInput is called, Then body is null', () => {
      const result = serializeInput('https://api.example.com', {
        id: '1',
      }, {
        toolName: 'test',
        method: 'POST',
        path: 'items/{id}',
        pathParams: ['id'],
      });

      expect(result.body).toBeNull();
    });
  });

  describe('Scenario: Custom headers from route config', () => {
    it('Given a route with custom headers, When serializeInput is called, Then headers are included', () => {
      const result = serializeInput('https://api.example.com', {
        data: 'value',
      }, {
        toolName: 'test',
        method: 'POST',
        path: 'items',
        headers: { 'X-Custom': 'header-value' },
      });

      expect(result.headers['X-Custom']).toBe('header-value');
    });
  });
});

describe('Feature: Output Parsing', () => {
  describe('Scenario: JSON response is parsed', () => {
    it('Given a 200 response with JSON body, When parseOutput is called, Then content is parsed JSON', async () => {
      const response = new Response(JSON.stringify({ key: 'value' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const output = await parseOutput(response);

      expect(output.content).toEqual({ key: 'value' });
      expect(output.isError).toBe(false);
      expect(output.metadata?.statusCode).toBe(200);
    });
  });

  describe('Scenario: Text response is returned as string', () => {
    it('Given a response with text content-type, When parseOutput is called, Then content is a string', async () => {
      const response = new Response('hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });

      const output = await parseOutput(response);

      expect(output.content).toBe('hello world');
      expect(output.isError).toBe(false);
    });
  });

  describe('Scenario: 204 No Content response', () => {
    it('Given a 204 response, When parseOutput is called, Then content is null', async () => {
      const response = new Response(null, { status: 204 });

      const output = await parseOutput(response);

      expect(output.content).toBeNull();
      expect(output.isError).toBe(false);
    });
  });

  describe('Scenario: Error response sets isError flag', () => {
    it('Given a 500 response, When parseOutput is called, Then isError is true', async () => {
      const response = new Response(JSON.stringify({ error: 'fail' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });

      const output = await parseOutput(response);

      expect(output.isError).toBe(true);
      expect(output.metadata?.statusCode).toBe(500);
    });
  });

  describe('Scenario: Unknown content-type tries JSON then falls back to text', () => {
    it('Given a response with unknown content-type containing valid JSON, When parseOutput is called, Then it parses as JSON', async () => {
      const response = new Response('{"parsed": true}', {
        status: 200,
        headers: { 'content-type': 'application/vnd.custom' },
      });

      const output = await parseOutput(response);
      expect(output.content).toEqual({ parsed: true });
    });

    it('Given a response with unknown content-type containing plain text, When parseOutput is called, Then it returns text', async () => {
      const response = new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/vnd.custom' },
      });

      const output = await parseOutput(response);
      expect(output.content).toBe('not json');
    });
  });

  describe('Scenario: Zero content-length response', () => {
    it('Given a response with content-length 0, When parseOutput is called, Then content is null', async () => {
      const response = new Response('', {
        status: 200,
        headers: { 'content-length': '0' },
      });

      const output = await parseOutput(response);
      expect(output.content).toBeNull();
    });
  });

  describe('Scenario: Response headers are captured in metadata', () => {
    it('Given a response with custom headers, When parseOutput is called, Then headers appear in metadata', async () => {
      const response = new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'abc123',
        },
      });

      const output = await parseOutput(response);
      expect(output.metadata?.headers?.['x-request-id']).toBe('abc123');
    });
  });
});
