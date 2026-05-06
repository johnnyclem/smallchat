import type {
  ArgumentSpec,
  CompilerHint,
  JSONSchemaType,
  ProviderManifest,
  ProviderCompilerHints,
  ToolDefinition,
  TransportType,
} from '../core/types.js';

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
  /** Resolved compiler hints (merged from provider defaults + tool overrides) */
  compilerHints?: CompilerHint;
  /** Provider-level hints (carried for reference during compilation) */
  providerHints?: ProviderCompilerHints;
  /** MCP Apps ui:// resource URI from _meta.ui.resourceUri */
  uiResourceUri?: string;
  /** MCP Apps visibility from _meta.ui.visibility */
  uiVisibility?: Array<'model' | 'app'>;
}

/** Parse an MCP-style manifest into ToolKit IR */
export function parseMCPManifest(manifest: ProviderManifest): ParsedTool[] {
  return manifest.tools.map(tool => {
    // Merge provider-level hints with tool-level hints (tool wins on conflict)
    const mergedHints = mergeCompilerHints(
      manifest.compilerHints,
      tool.compilerHints,
    );

    return {
      providerId: manifest.id,
      name: tool.name,
      description: tool.description,
      arguments: extractArguments(tool.inputSchema),
      transportType: manifest.transportType,
      compilerHints: mergedHints,
      providerHints: manifest.compilerHints,
      // MCP Apps: extract ui:// resource metadata from _meta.ui (spec 2026-01-26)
      uiResourceUri: tool.uiResourceUri,
      uiVisibility: tool.uiVisibility,
    };
  });
}

/**
 * Merge provider-level compiler hints with tool-level overrides.
 * Tool-level values take precedence over provider-level defaults.
 */
export function mergeCompilerHints(
  providerHints?: ProviderCompilerHints,
  toolHints?: CompilerHint,
): CompilerHint | undefined {
  if (!providerHints && !toolHints) return undefined;
  if (!providerHints) return toolHints;
  if (!toolHints) {
    // Promote relevant provider hints into a tool-level hint
    return {
      selectorHint: providerHints.selectorHint,
      priority: providerHints.priority,
    };
  }

  // Tool-level wins, but inherit unset fields from provider
  return {
    selectorHint: toolHints.selectorHint ?? providerHints.selectorHint,
    pinSelector: toolHints.pinSelector,
    aliases: toolHints.aliases,
    priority: toolHints.priority ?? providerHints.priority,
    preferred: toolHints.preferred,
    exclude: toolHints.exclude,
    vendorMeta: toolHints.vendorMeta,
  };
}

/**
 * Apply project-level hint overrides from smallchat.json onto parsed tools.
 * Called after initial parsing but before compilation.
 */
export function applyManifestOverrides(
  tools: ParsedTool[],
  providerHints?: Record<string, ProviderCompilerHints>,
  toolHints?: Record<string, CompilerHint>,
): ParsedTool[] {
  if (!providerHints && !toolHints) return tools;

  return tools.map(tool => {
    const providerOverride = providerHints?.[tool.providerId];
    const toolKey = `${tool.providerId}.${tool.name}`;
    const toolOverride = toolHints?.[toolKey];

    if (!providerOverride && !toolOverride) return tool;

    // Re-merge: existing hints + provider override + tool override
    const baseHints = mergeCompilerHints(providerOverride, tool.compilerHints);
    const finalHints = toolOverride
      ? mergeCompilerHints(undefined, { ...baseHints, ...toolOverride })
      : baseHints;

    return { ...tool, compilerHints: finalHints };
  });
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
