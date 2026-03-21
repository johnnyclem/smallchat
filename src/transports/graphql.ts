/**
 * GraphQL Transport — execute GraphQL queries/mutations as Smallchat tools
 *
 * Implements a transport capable of executing GraphQL operations against any
 * GraphQL endpoint. Tools defined with transportType 'graphql' use this
 * transport to run queries.
 *
 * Features:
 *  - Supports query, mutation, and subscription (streaming) operations
 *  - Variable injection from tool arguments
 *  - Introspection-based schema discovery
 *  - Type-safe response extraction
 *  - Persisted query support (optional)
 *
 * Usage:
 *
 *   import { GraphQLTransport } from './transports/graphql';
 *
 *   const transport = new GraphQLTransport({
 *     endpoint: 'https://api.example.com/graphql',
 *     headers: { Authorization: 'Bearer ...' },
 *   });
 *
 *   // Define a tool that wraps a GraphQL query
 *   const imp: ToolIMP = {
 *     ...
 *     execute: (args) => transport.execute('search_repos', args),
 *   };
 */

import type { ToolResult, InferenceDelta } from '../core/types.js';

// ---------------------------------------------------------------------------
// GraphQL transport config
// ---------------------------------------------------------------------------

export interface GraphQLTransportOptions {
  endpoint: string;
  headers?: Record<string, string>;
  /** Default timeout in milliseconds */
  timeout?: number;
  /** Whether to include __typename in all queries */
  includeTypenames?: boolean;
  /** Persisted query map: operationName → SHA-256 hash */
  persistedQueries?: Record<string, string>;
}

export interface GraphQLOperation {
  /** GraphQL query/mutation/subscription document */
  query: string;
  /** Operation name (for persisted queries) */
  operationName?: string;
  /** Variables to inject */
  variables?: Record<string, unknown>;
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: GraphQLError[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool definition format for GraphQL tools
// ---------------------------------------------------------------------------

export interface GraphQLToolDefinition {
  /** Tool name */
  name: string;
  /** Human-readable description */
  description: string;
  /** The GraphQL operation to execute */
  operation: GraphQLOperation;
  /**
   * Map from tool arg name to GraphQL variable name.
   * Default: identity mapping (tool arg name === variable name).
   */
  variableMapping?: Record<string, string>;
  /**
   * JSONPath or dot-notation path to extract from the response data.
   * Example: 'repository.issues.nodes'
   * Default: return the entire data object.
   */
  resultPath?: string;
}

// ---------------------------------------------------------------------------
// GraphQLTransport
// ---------------------------------------------------------------------------

export class GraphQLTransport {
  private endpoint: string;
  private headers: Record<string, string>;
  private timeout: number;
  private persistedQueries: Record<string, string>;

  constructor(options: GraphQLTransportOptions) {
    this.endpoint = options.endpoint;
    this.headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };
    this.timeout = options.timeout ?? 30000;
    this.persistedQueries = options.persistedQueries ?? {};
  }

  // ---------------------------------------------------------------------------
  // execute — run a single GraphQL operation
  // ---------------------------------------------------------------------------

  async execute<T = unknown>(
    operation: GraphQLOperation,
    toolArgs?: Record<string, unknown>,
  ): Promise<ToolResult> {
    const variables = toolArgs
      ? mergeVariables(operation.variables ?? {}, toolArgs)
      : operation.variables;

    const body = this.buildRequestBody(operation, variables);

    try {
      const response = await fetchWithTimeout(
        this.endpoint,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
        },
        this.timeout,
      );

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: null,
          isError: true,
          metadata: {
            error: `GraphQL endpoint returned ${response.status}: ${errorText}`,
            statusCode: response.status,
          },
        };
      }

      const gqlResponse = (await response.json()) as GraphQLResponse<T>;

      if (gqlResponse.errors && gqlResponse.errors.length > 0) {
        return {
          content: gqlResponse.data ?? null,
          isError: true,
          metadata: {
            graphqlErrors: gqlResponse.errors,
            error: gqlResponse.errors.map(e => e.message).join('; '),
          },
        };
      }

      return {
        content: gqlResponse.data ?? null,
        isError: false,
        metadata: gqlResponse.extensions,
      };
    } catch (err) {
      return {
        content: null,
        isError: true,
        metadata: { error: `GraphQL transport error: ${(err as Error).message}` },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // executeFromDefinition — resolve variables from tool args
  // ---------------------------------------------------------------------------

  async executeFromDefinition(
    def: GraphQLToolDefinition,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // Map tool args to GraphQL variables
    const variables: Record<string, unknown> = {};
    if (def.variableMapping) {
      for (const [argName, varName] of Object.entries(def.variableMapping)) {
        if (args[argName] !== undefined) {
          variables[varName] = args[argName];
        }
      }
    } else {
      Object.assign(variables, args);
    }

    const result = await this.execute(
      { ...def.operation, variables },
    );

    // Optionally extract a nested path from the result
    if (!result.isError && def.resultPath && result.content) {
      result.content = extractPath(result.content, def.resultPath);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // introspect — fetch the schema via introspection query
  // ---------------------------------------------------------------------------

  async introspect(): Promise<ToolResult> {
    const introspectionQuery = `
      query IntrospectionQuery {
        __schema {
          types {
            name
            kind
            description
            fields(includeDeprecated: false) {
              name
              description
              type { name kind ofType { name kind } }
              args { name description type { name kind } }
            }
          }
          queryType { name }
          mutationType { name }
          subscriptionType { name }
        }
      }
    `;

    return this.execute({ query: introspectionQuery, operationName: 'IntrospectionQuery' });
  }

  // ---------------------------------------------------------------------------
  // stream — execute subscription or chunked query
  // ---------------------------------------------------------------------------

  async *stream(
    operation: GraphQLOperation,
    toolArgs?: Record<string, unknown>,
  ): AsyncGenerator<InferenceDelta> {
    const variables = toolArgs
      ? mergeVariables(operation.variables ?? {}, toolArgs)
      : operation.variables;

    const body = this.buildRequestBody(operation, variables);

    try {
      const response = await fetchWithTimeout(
        this.endpoint,
        {
          method: 'POST',
          headers: {
            ...this.headers,
            Accept: 'text/event-stream, multipart/mixed',
          },
          body: JSON.stringify(body),
        },
        this.timeout,
      );

      if (!response.ok || !response.body) return;

      const bodyStream = response.body as unknown as { getReader(): { read(): Promise<{ done: boolean; value: Uint8Array }>; releaseLock(): void } };
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') return;

          try {
            const chunk = JSON.parse(data) as GraphQLResponse;
            if (chunk.data) {
              yield {
                text: JSON.stringify(chunk.data),
                finishReason: null,
              };
            }
          } catch {
            // skip malformed chunks
          }
        }
      }
    } catch {
      // stream failed
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildRequestBody(
    operation: GraphQLOperation,
    variables?: Record<string, unknown>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      query: operation.query,
    };

    if (operation.operationName) {
      body.operationName = operation.operationName;

      // Use persisted query hash if available
      const hash = this.persistedQueries[operation.operationName];
      if (hash) {
        body.extensions = {
          persistedQuery: { version: 1, sha256Hash: hash },
        };
        // APQ: omit query on first try if hash is available
        delete body.query;
      }
    }

    if (variables && Object.keys(variables).length > 0) {
      body.variables = variables;
    }

    return body;
  }
}

// ---------------------------------------------------------------------------
// GraphQL tool factory — build ToolIMP from a GraphQL tool definition
// ---------------------------------------------------------------------------

import type { ToolIMP, ArgumentConstraints } from '../core/types.js';

export function createGraphQLToolIMP(
  transport: GraphQLTransport,
  def: GraphQLToolDefinition,
  providerId: string,
): ToolIMP {
  const schema = {
    name: def.name,
    description: def.description,
    inputSchema: {
      type: 'object' as const,
      properties: buildPropertiesFromOperation(def.operation),
      required: [],
    },
    arguments: [],
  };

  const constraints: ArgumentConstraints = {
    required: [],
    optional: [],
    validate: () => ({ valid: true, errors: [] }),
  };

  return {
    providerId,
    toolName: def.name,
    transportType: 'rest', // We use 'rest' as the closest mapping; callers can extend TransportType
    schema,
    schemaLoader: async () => schema,
    constraints,
    execute: (args) => transport.executeFromDefinition(def, args),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; headers: { get(k: string): string | null }; text(): Promise<string>; json(): Promise<unknown>; body: unknown }> {
  // Use dynamic access to avoid TS errors in environments without DOM typings
  const AbortCtrl = (globalThis as Record<string, unknown>).AbortController as new () => { abort(): void; signal: unknown };
  const controller = new AbortCtrl();
  const timer = (globalThis as Record<string, unknown>).setTimeout as (fn: () => void, ms: number) => unknown;
  const clearTimer = (globalThis as Record<string, unknown>).clearTimeout as (t: unknown) => void;
  const t = timer(() => controller.abort(), timeoutMs);
  try {
    const fetchFn = (globalThis as Record<string, unknown>).fetch as (url: string, init: unknown) => Promise<{ ok: boolean; status: number; headers: { get(k: string): string | null }; text(): Promise<string>; json(): Promise<unknown>; body: unknown }>;
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimer(t);
  }
}

function mergeVariables(
  base: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...args };
}

function extractPath(data: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function buildPropertiesFromOperation(
  operation: GraphQLOperation,
): Record<string, { type: string; description: string }> {
  // Parse variable definitions from the query document
  const varPattern = /\$(\w+)\s*:\s*(\w+[!]?)/g;
  const props: Record<string, { type: string; description: string }> = {};
  let match: RegExpExecArray | null;

  while ((match = varPattern.exec(operation.query)) !== null) {
    const [, name, gqlType] = match;
    props[name] = {
      type: gqlTypeToJsonType(gqlType.replace('!', '')),
      description: `GraphQL variable $${name} (${gqlType})`,
    };
  }

  // Also include preset variables as optional props
  for (const [key] of Object.entries(operation.variables ?? {})) {
    if (!props[key]) {
      props[key] = { type: 'string', description: `GraphQL variable $${key}` };
    }
  }

  return props;
}

function gqlTypeToJsonType(gqlType: string): string {
  switch (gqlType.toLowerCase()) {
    case 'string': case 'id': return 'string';
    case 'int': case 'float': return 'number';
    case 'boolean': return 'boolean';
    default: return 'string';
  }
}
