/**
 * Postman Collection Importer — converts Postman Collections to transport config.
 *
 * Parses a Postman Collection v2.1 format and produces:
 *   - HttpTransportRoute[] for the HttpTransport
 *   - ToolDefinition[] compatible with the smallchat compiler
 */

import type {
  HttpMethod,
  HttpTransportRoute,
  GeneratedHttpConfig,
  PostmanCollection,
  PostmanItem,
  PostmanRequest,
  AuthStrategy,
} from './types.js';
import type { ToolDefinition, JSONSchemaType } from '../core/types.js';
import { BearerTokenAuth } from './auth.js';

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

/**
 * Import a Postman Collection and generate HTTP transport configuration.
 *
 * @param collection - Parsed Postman Collection object
 * @param options - Import options
 * @returns Generated config with routes
 */
export function importPostmanCollection(
  collection: PostmanCollection,
  options?: {
    /** Override the base URL (replaces Postman variables) */
    baseUrl?: string;
    /** Override auth from collection */
    auth?: AuthStrategy;
  },
): GeneratedHttpConfig {
  const routes: HttpTransportRoute[] = [];
  const variables = buildVariableMap(collection.variable);

  // Resolve base URL from collection variables or first request
  let baseUrl = options?.baseUrl ?? resolveBaseUrl(collection, variables);

  // Resolve auth from collection
  let auth = options?.auth ?? resolveAuth(collection.auth);

  // Recursively process items (handles folders)
  const items = flattenItems(collection.item);

  for (const item of items) {
    if (!item.request) continue;

    const route = requestToRoute(item.name, item.request, variables, baseUrl);
    if (route) {
      routes.push(route);
    }
  }

  return { baseUrl, routes, auth };
}

/**
 * Import a Postman Collection as ToolDefinitions (for the compiler pipeline).
 */
export function postmanToToolDefinitions(
  collection: PostmanCollection,
  providerId?: string,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const id = providerId ?? collection.info.name;
  const variables = buildVariableMap(collection.variable);

  const items = flattenItems(collection.item);

  for (const item of items) {
    if (!item.request) continue;

    const toolName = sanitizeToolName(item.name);
    const method = item.request.method?.toUpperCase() ?? 'GET';
    const url = resolveUrl(item.request.url, variables);

    // Build input schema from query params and body
    const inputSchema = buildInputSchemaFromRequest(item.request, variables);

    tools.push({
      name: toolName,
      description: `${method} ${url}`,
      inputSchema,
      providerId: id,
      transportType: 'rest',
    });
  }

  return tools;
}

/**
 * Parse a Postman Collection JSON file.
 */
export function parsePostmanCollection(json: string): PostmanCollection {
  const collection = JSON.parse(json) as PostmanCollection;

  if (!collection.info?.schema?.includes('postman')) {
    throw new Error('Invalid Postman Collection format');
  }

  return collection;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenItems(items: PostmanItem[], prefix = ''): PostmanItem[] {
  const flat: PostmanItem[] = [];

  for (const item of items) {
    if (item.item) {
      // This is a folder — recurse
      const folderPrefix = prefix ? `${prefix}/${item.name}` : item.name;
      flat.push(...flattenItems(item.item, folderPrefix));
    } else {
      // Apply folder prefix to name
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      flat.push({ ...item, name });
    }
  }

  return flat;
}

function requestToRoute(
  name: string,
  request: PostmanRequest,
  variables: Map<string, string>,
  baseUrl: string,
): HttpTransportRoute | null {
  const method = (request.method?.toUpperCase() ?? 'GET') as HttpMethod;
  const fullUrl = resolveUrl(request.url, variables);

  // Extract path relative to base URL
  let path = fullUrl;
  if (path.startsWith(baseUrl)) {
    path = path.slice(baseUrl.length);
  }
  // Strip protocol/host if still present
  try {
    const parsed = new URL(fullUrl);
    path = parsed.pathname + parsed.search;
  } catch {
    // Keep path as-is
  }

  // Extract query params
  const queryParams = request.url.query?.map((q) => q.key) ?? [];

  // Extract path params (Postman uses :param syntax)
  const pathParams: string[] = [];
  path = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, param) => {
    pathParams.push(param);
    return `{${param}}`;
  });

  // Extract body params
  const bodyParams: string[] = [];
  if (request.body?.mode === 'raw' && request.body.raw) {
    try {
      const body = JSON.parse(resolveVariables(request.body.raw, variables));
      if (typeof body === 'object' && body !== null) {
        bodyParams.push(...Object.keys(body));
      }
    } catch {
      // Not valid JSON
    }
  } else if (request.body?.mode === 'formdata') {
    for (const field of request.body.formdata ?? []) {
      bodyParams.push(field.key);
    }
  }

  // Extract custom headers
  const headers: Record<string, string> = {};
  for (const header of request.header ?? []) {
    if (header.key.toLowerCase() !== 'content-type' && header.key.toLowerCase() !== 'authorization') {
      headers[header.key] = resolveVariables(header.value, variables);
    }
  }

  return {
    toolName: sanitizeToolName(name),
    method,
    path,
    queryParams: queryParams.length > 0 ? queryParams : undefined,
    pathParams: pathParams.length > 0 ? pathParams : undefined,
    bodyParams: bodyParams.length > 0 ? bodyParams : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

function buildInputSchemaFromRequest(
  request: PostmanRequest,
  variables: Map<string, string>,
): JSONSchemaType {
  const properties: Record<string, JSONSchemaType> = {};

  // Query params
  for (const q of request.url.query ?? []) {
    properties[q.key] = { type: 'string', description: q.key };
  }

  // Body params
  if (request.body?.mode === 'raw' && request.body.raw) {
    try {
      const body = JSON.parse(resolveVariables(request.body.raw, variables));
      if (typeof body === 'object' && body !== null) {
        for (const [key, value] of Object.entries(body)) {
          properties[key] = {
            type: inferJsonType(value),
            description: key,
          };
        }
      }
    } catch {
      // Not valid JSON
    }
  }

  return {
    type: 'object',
    properties,
  };
}

function buildVariableMap(variables?: Array<{ key: string; value: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of variables ?? []) {
    map.set(v.key, v.value);
  }
  return map;
}

function resolveVariables(text: string, variables: Map<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key) => variables.get(key.trim()) ?? `{{${key}}}`);
}

function resolveUrl(url: PostmanRequest['url'], variables: Map<string, string>): string {
  if (typeof url === 'string') return resolveVariables(url, variables);
  if (url.raw) return resolveVariables(url.raw, variables);

  const protocol = url.protocol ?? 'https';
  const host = url.host?.join('.') ?? 'localhost';
  const path = url.path?.join('/') ?? '';
  return resolveVariables(`${protocol}://${host}/${path}`, variables);
}

function resolveBaseUrl(collection: PostmanCollection, variables: Map<string, string>): string {
  // Try to find a common base URL from the first request
  const items = flattenItems(collection.item);
  for (const item of items) {
    if (item.request?.url) {
      const url = resolveUrl(item.request.url, variables);
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}`;
      } catch {
        continue;
      }
    }
  }
  return 'http://localhost';
}

function resolveAuth(auth?: PostmanCollection['auth']): AuthStrategy | undefined {
  if (!auth) return undefined;

  if (auth.type === 'bearer' && auth.bearer) {
    const tokenEntry = auth.bearer.find((e) => e.key === 'token');
    if (tokenEntry?.value) {
      return new BearerTokenAuth({ token: tokenEntry.value });
    }
  }

  return undefined;
}

function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\s-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

function inferJsonType(value: unknown): string {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'string';
  return 'object';
}
