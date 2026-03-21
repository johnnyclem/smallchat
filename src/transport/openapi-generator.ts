/**
 * OpenAPI Generator — generates HTTP Transport configurations from OpenAPI specs.
 *
 * Parses an OpenAPI 3.x specification and produces:
 *   - HttpTransportRoute[] for the HttpTransport
 *   - ToolDefinition[] compatible with the smallchat compiler
 */

import type { HttpMethod, HttpTransportRoute, GeneratedHttpConfig, AuthStrategy } from './types.js';
import type { ToolDefinition, JSONSchemaType } from '../core/types.js';
import { BearerTokenAuth, OAuth2ClientCredentialsAuth } from './auth.js';

// ---------------------------------------------------------------------------
// OpenAPI types (3.x)
// ---------------------------------------------------------------------------

interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, OpenAPIPathItem>;
  components?: {
    schemas?: Record<string, OpenAPISchema>;
    securitySchemes?: Record<string, OpenAPISecurityScheme>;
  };
  security?: Array<Record<string, string[]>>;
}

interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  head?: OpenAPIOperation;
  options?: OpenAPIOperation;
  parameters?: OpenAPIParameter[];
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  tags?: string[];
}

interface OpenAPIParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: OpenAPISchema;
}

interface OpenAPIRequestBody {
  content?: Record<string, { schema?: OpenAPISchema }>;
  required?: boolean;
}

interface OpenAPISchema {
  type?: string;
  description?: string;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  items?: OpenAPISchema;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  $ref?: string;
}

interface OpenAPISecurityScheme {
  type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect';
  scheme?: string;
  bearerFormat?: string;
  name?: string;
  in?: string;
  flows?: {
    clientCredentials?: {
      tokenUrl: string;
      scopes?: Record<string, string>;
    };
  };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate HTTP transport configuration from an OpenAPI spec.
 *
 * @param spec - The parsed OpenAPI specification object
 * @param options - Generation options
 * @returns Generated config with routes and optional auth
 */
export function generateFromOpenAPI(
  spec: OpenAPISpec,
  options?: {
    /** Override the base URL from the spec */
    baseUrl?: string;
    /** Provide auth credentials */
    auth?: { bearerToken?: string; clientId?: string; clientSecret?: string };
    /** Only generate routes matching these tags */
    filterTags?: string[];
    /** Only generate routes matching these operation IDs */
    filterOperationIds?: string[];
  },
): GeneratedHttpConfig {
  const baseUrl = options?.baseUrl ?? spec.servers?.[0]?.url ?? 'http://localhost';
  const routes: HttpTransportRoute[] = [];
  let auth: AuthStrategy | undefined;

  // Resolve auth
  if (options?.auth?.bearerToken) {
    auth = new BearerTokenAuth({ token: options.auth.bearerToken });
  } else if (options?.auth?.clientId && options?.auth?.clientSecret) {
    const scheme = findOAuth2Scheme(spec);
    if (scheme?.flows?.clientCredentials) {
      auth = new OAuth2ClientCredentialsAuth({
        clientId: options.auth.clientId,
        clientSecret: options.auth.clientSecret,
        tokenUrl: scheme.flows.clientCredentials.tokenUrl,
        scopes: scheme.flows.clientCredentials.scopes
          ? Object.keys(scheme.flows.clientCredentials.scopes)
          : undefined,
      });
    }
  }

  // Process each path and method
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const pathParams = pathItem.parameters ?? [];

    for (const method of ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const) {
      const operation = pathItem[method];
      if (!operation) continue;

      // Apply tag filter
      if (options?.filterTags?.length) {
        const tags = operation.tags ?? [];
        if (!tags.some((t) => options.filterTags!.includes(t))) continue;
      }

      // Apply operation ID filter
      if (options?.filterOperationIds?.length) {
        if (!operation.operationId || !options.filterOperationIds.includes(operation.operationId)) {
          continue;
        }
      }

      // Generate a tool name from operationId or path+method
      const toolName = operation.operationId ?? generateToolName(method, path);

      // Collect parameters by location
      const allParams = [...pathParams, ...(operation.parameters ?? [])];
      const pathParamNames = allParams.filter((p) => p.in === 'path').map((p) => p.name);
      const queryParamNames = allParams.filter((p) => p.in === 'query').map((p) => p.name);
      const headerParams: Record<string, string> = {};
      for (const p of allParams.filter((p) => p.in === 'header')) {
        headerParams[p.name] = '';
      }

      // Get body params from requestBody
      const bodyParams = extractBodyParams(operation.requestBody, spec);

      routes.push({
        toolName,
        method: method.toUpperCase() as HttpMethod,
        path,
        pathParams: pathParamNames.length > 0 ? pathParamNames : undefined,
        queryParams: queryParamNames.length > 0 ? queryParamNames : undefined,
        bodyParams: bodyParams.length > 0 ? bodyParams : undefined,
        headers: Object.keys(headerParams).length > 0 ? headerParams : undefined,
      });
    }
  }

  return { baseUrl, routes, auth };
}

/**
 * Generate ToolDefinition[] from an OpenAPI spec (for the compiler pipeline).
 */
export function openAPIToToolDefinitions(
  spec: OpenAPISpec,
  providerId?: string,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const id = providerId ?? spec.info.title;

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const pathParams = pathItem.parameters ?? [];

    for (const method of ['get', 'post', 'put', 'delete', 'patch'] as const) {
      const operation = pathItem[method];
      if (!operation) continue;

      const toolName = operation.operationId ?? generateToolName(method, path);
      const description = operation.summary ?? operation.description ?? `${method.toUpperCase()} ${path}`;

      // Build input schema from parameters and request body
      const inputSchema = buildInputSchema(
        [...pathParams, ...(operation.parameters ?? [])],
        operation.requestBody,
        spec,
      );

      tools.push({
        name: toolName,
        description,
        inputSchema,
        providerId: id,
        transportType: 'rest',
      });
    }
  }

  return tools;
}

/**
 * Fetch and parse an OpenAPI spec from a URL.
 */
export async function fetchOpenAPISpec(url: string): Promise<OpenAPISpec> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from ${url}: ${response.status}`);
  }
  return (await response.json()) as OpenAPISpec;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToolName(method: string, path: string): string {
  // Convert "/users/{id}/posts" to "users_id_posts" and prepend method
  const cleaned = path
    .replace(/\{([^}]+)\}/g, '$1')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method}_${cleaned}`;
}

function extractBodyParams(
  requestBody: OpenAPIRequestBody | undefined,
  spec: OpenAPISpec,
): string[] {
  if (!requestBody?.content) return [];

  const jsonContent = requestBody.content['application/json'];
  if (!jsonContent?.schema) return [];

  const schema = resolveRef(jsonContent.schema, spec);
  if (schema.properties) {
    return Object.keys(schema.properties);
  }
  return [];
}

function buildInputSchema(
  parameters: OpenAPIParameter[],
  requestBody: OpenAPIRequestBody | undefined,
  spec: OpenAPISpec,
): JSONSchemaType {
  const properties: Record<string, JSONSchemaType> = {};
  const required: string[] = [];

  // Add path and query parameters
  for (const param of parameters) {
    const schema = param.schema ? resolveRef(param.schema, spec) : { type: 'string' };
    properties[param.name] = {
      type: schema.type ?? 'string',
      description: param.description ?? param.name,
      enum: schema.enum,
      default: schema.default,
    };
    if (param.required) {
      required.push(param.name);
    }
  }

  // Add request body properties
  if (requestBody?.content) {
    const jsonContent = requestBody.content['application/json'];
    if (jsonContent?.schema) {
      const bodySchema = resolveRef(jsonContent.schema, spec);
      if (bodySchema.properties) {
        for (const [name, propSchema] of Object.entries(bodySchema.properties)) {
          const resolved = resolveRef(propSchema, spec);
          properties[name] = {
            type: resolved.type ?? 'string',
            description: resolved.description ?? name,
            enum: resolved.enum,
            default: resolved.default,
          };
        }
        if (bodySchema.required) {
          required.push(...bodySchema.required);
        }
      }
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function resolveRef(schema: OpenAPISchema, spec: OpenAPISpec): OpenAPISchema {
  if (!schema.$ref) return schema;

  // Handle #/components/schemas/Foo references
  const refPath = schema.$ref.replace('#/', '').split('/');
  let current: unknown = spec;
  for (const segment of refPath) {
    current = (current as Record<string, unknown>)?.[segment];
  }

  return (current as OpenAPISchema) ?? schema;
}

function findOAuth2Scheme(spec: OpenAPISpec): OpenAPISecurityScheme | undefined {
  if (!spec.components?.securitySchemes) return undefined;
  for (const scheme of Object.values(spec.components.securitySchemes)) {
    if (scheme.type === 'oauth2') return scheme;
  }
  return undefined;
}
