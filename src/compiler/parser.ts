import type { ArgumentSpec, JSONSchemaType, ProviderManifest, ToolDefinition, TransportType } from '../core/types.js';

/**
 * Parser — Phase 1 of the compilation pipeline.
 *
 * Normalizes tool definitions from various sources (MCP manifests,
 * OpenAPI specs, raw JSON schemas) into ToolKit's internal representation.
 */

/** Parsed tool in ToolKit IR */
export interface ParsedTool {
  providerId: string;
  name: string;
  description: string;
  arguments: ArgumentSpec[];
  transportType: TransportType;
}

/** Parse an MCP-style manifest into ToolKit IR */
export function parseMCPManifest(manifest: ProviderManifest): ParsedTool[] {
  return manifest.tools.map(tool => ({
    providerId: manifest.id,
    name: tool.name,
    description: tool.description,
    arguments: extractArguments(tool.inputSchema),
    transportType: manifest.transportType,
  }));
}

/** Parse an OpenAPI spec into ToolKit IR */
export function parseOpenAPISpec(spec: OpenAPISpec): ParsedTool[] {
  const tools: ParsedTool[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods as Record<string, OpenAPIOperation>)) {
      if (!operation.operationId) continue;

      const args: ArgumentSpec[] = (operation.parameters ?? []).map(
        (p: OpenAPIParameter) => ({
          name: p.name,
          type: p.schema ?? { type: 'string' },
          description: p.description ?? p.name,
          required: p.required ?? false,
        }),
      );

      tools.push({
        providerId: spec.info?.title ?? 'unknown',
        name: operation.operationId,
        description: operation.summary ?? operation.description ?? `${method.toUpperCase()} ${path}`,
        arguments: args,
        transportType: 'rest',
      });
    }
  }

  return tools;
}

/** Parse raw JSON schema tool definitions */
export function parseRawSchema(definition: ToolDefinition): ParsedTool {
  return {
    providerId: definition.providerId,
    name: definition.name,
    description: definition.description,
    arguments: extractArguments(definition.inputSchema),
    transportType: definition.transportType,
  };
}

/** Extract ArgumentSpecs from a JSON schema */
function extractArguments(schema: JSONSchemaType): ArgumentSpec[] {
  if (!schema.properties) return [];

  const required = new Set(schema.required ?? []);

  return Object.entries(schema.properties).map(([name, propSchema]) => ({
    name,
    type: propSchema,
    description: propSchema.description ?? name,
    required: required.has(name),
    enum: propSchema.enum,
    default: propSchema.default,
  }));
}

// Minimal OpenAPI types for parsing
export interface OpenAPISpec {
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, OpenAPIOperation>>;
}

export interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
}

export interface OpenAPIParameter {
  name: string;
  description?: string;
  required?: boolean;
  schema?: JSONSchemaType;
}
