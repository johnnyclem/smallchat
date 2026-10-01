/**
 * Artifact format 1.0 — the one writer (buildArtifact) and the one
 * validating reader (validateArtifact / parseArtifact).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type {
  CompilationResult,
  EmbedderFingerprint,
  LaunchSpec,
  ProviderManifest,
  ToolAnnotations,
  ToolDefinition,
} from '../core/types.js';
import { canonicalJson } from '../core/jcs.js';
import { safeJsonParse } from '../core/safe-json.js';
import { toolId } from '../core/tool-id.js';
import {
  ARTIFACT_FORMAT_VERSION,
  ArtifactFormatError,
  ArtifactVersionError,
  type ArtifactProvider,
  type ArtifactSelector,
  type ArtifactTool,
  type ArtifactV1,
} from './types.js';

/** Domain-separation prefix of the artifact content hash. */
export const ARTIFACT_HASH_DOMAIN = 'smallchat.artifact.v1';

/** Absolute path of the normative JSON Schema (shipped in the package). */
export const ARTIFACT_SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'spec',
  'artifact',
  'artifact.v1.schema.json',
);

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface BuildArtifactOptions {
  /** Tool-specific metadata stored under `extensions` (e.g. `{ dream: … }`) */
  extensions?: Record<string, unknown>;
}

/**
 * Build a 1.0 artifact from a compilation result and the manifests it was
 * compiled from. `embedder` must be the fingerprint of the embedder the
 * compiler used — it is what every load path checks against.
 *
 * The result is validated before it is returned, so the writer can only
 * emit artifacts the loader accepts.
 */
export function buildArtifact(
  result: CompilationResult,
  manifests: ProviderManifest[],
  embedder: EmbedderFingerprint,
  options: BuildArtifactOptions = {},
): ArtifactV1 {
  const definitions = new Map<string, { manifest: ProviderManifest; tool: ToolDefinition }>();
  for (const manifest of manifests) {
    for (const tool of manifest.tools) {
      const id = toolId(manifest.id, tool.name);
      if (!definitions.has(id)) definitions.set(id, { manifest, tool });
    }
  }

  const providers: Record<string, ArtifactProvider> = {};
  const tools: Record<string, ArtifactTool> = {};
  const selectors: Record<string, ArtifactSelector> = {};

  for (const ref of result.tools) {
    const definition = definitions.get(ref.id);
    if (!definition) {
      throw new ArtifactFormatError(`Compiled tool ${ref.id} has no definition in the supplied manifests`);
    }
    const { manifest, tool } = definition;
    providers[manifest.id] ??= buildProvider(manifest);

    tools[ref.id] = withoutUndefined({
      id: ref.id,
      providerId: ref.providerId,
      name: ref.toolName,
      title: tool.title,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema as unknown as Record<string, unknown>) ?? { type: 'object', properties: {} },
      outputSchema: tool.outputSchema,
      annotations: pickAnnotations(tool.annotations),
      transportType: manifest.transportType,
      selector: ref.selector,
      compilerHints: tool.compilerHints as Record<string, unknown> | undefined,
      ui: tool.uiResourceUri
        ? withoutUndefined({ resourceUri: tool.uiResourceUri, visibility: tool.uiVisibility })
        : undefined,
    });

    const owned: Array<[string, ArtifactSelector['kind']]> = [
      [ref.selector, 'tool'],
      ...ref.aliases.map(a => [a, 'alias'] as [string, ArtifactSelector['kind']]),
    ];
    for (const [canonical, kind] of owned) {
      const selector = result.selectors.get(canonical);
      if (!selector) {
        throw new ArtifactFormatError(`Selector ${canonical} of ${ref.id} is missing from the compilation result`);
      }
      selectors[canonical] = { canonical, toolId: ref.id, kind, vector: Array.from(selector.vector) };
    }
  }

  const body: Omit<ArtifactV1, 'contentHash'> = {
    formatVersion: ARTIFACT_FORMAT_VERSION,
    embedder: { ...embedder },
    providers,
    tools,
    selectors,
    collisions: result.collisions.map(c => ({
      selectorA: c.selectorA,
      selectorB: c.selectorB,
      similarity: c.similarity,
      hint: c.hint,
    })),
    duplicates: result.duplicates.map(d => ({ ...d })),
    stats: {
      toolCount: Object.keys(tools).length,
      selectorCount: Object.keys(selectors).length,
      providerCount: Object.keys(providers).length,
      collisionCount: result.collisions.length,
      duplicateCount: result.duplicates.length,
    },
    ...(options.extensions ? { extensions: options.extensions } : {}),
  };

  const artifact: ArtifactV1 = { ...body, contentHash: computeContentHash(body) };
  return validateArtifact(artifact, 'built artifact');
}

function buildProvider(manifest: ProviderManifest): ArtifactProvider {
  return withoutUndefined({
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    transportType: manifest.transportType,
    version: manifest.version,
    launch: launchOf(manifest),
    compilerHints: manifest.compilerHints as Record<string, unknown> | undefined,
    channel: manifest.channel?.isChannel ? withoutUndefined({ ...manifest.channel }) : undefined,
  });
}

/** The manifest's launch spec, or one derived from a bare `endpoint`. */
function launchOf(manifest: ProviderManifest): LaunchSpec | undefined {
  if (manifest.launch) {
    return manifest.launch.transport === 'stdio'
      ? {
          transport: 'stdio',
          command: manifest.launch.command,
          args: [...manifest.launch.args],
          env: [...new Set(manifest.launch.env)],
        }
      : { transport: manifest.launch.transport, url: manifest.launch.url };
  }
  if (manifest.endpoint) {
    return {
      transport: manifest.transportType === 'mcp' ? 'streamable-http' : 'http',
      url: manifest.endpoint,
    };
  }
  return undefined;
}

const ANNOTATION_FLAGS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** Copy only the MCP annotation fields the format defines. */
function pickAnnotations(annotations: ToolAnnotations | undefined): ToolAnnotations | undefined {
  if (!annotations || typeof annotations !== 'object') return undefined;
  const picked: ToolAnnotations = {};
  if (typeof annotations.title === 'string') picked.title = annotations.title;
  for (const flag of ANNOTATION_FLAGS) {
    if (typeof annotations[flag] === 'boolean') picked[flag] = annotations[flag];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * sha256hex(UTF8("smallchat.artifact.v1") || 0x00 || UTF8(JCS(body))), where
 * body is the artifact without its `contentHash` field.
 */
export function computeContentHash(artifact: Omit<ArtifactV1, 'contentHash'> | ArtifactV1): string {
  const { contentHash: _ignored, ...body } = artifact as ArtifactV1;
  return createHash('sha256')
    .update(ARTIFACT_HASH_DOMAIN, 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalJson(body), 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

let schemaValidator: ValidateFunction | null = null;

function getSchemaValidator(): ValidateFunction {
  if (!schemaValidator) {
    const schema = JSON.parse(readFileSync(ARTIFACT_SCHEMA_PATH, 'utf-8')) as Record<string, unknown>;
    const Ajv2020 = Ajv2020Import.default;
    schemaValidator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  }
  return schemaValidator;
}

/**
 * Validate an in-memory value as a 1.0 artifact: format version, JSON
 * Schema, internal consistency (ids, selector ownership, vector dimensions,
 * stats) and content hash. Returns the value typed as ArtifactV1, or throws
 * ArtifactVersionError (older/newer format) or ArtifactFormatError.
 */
export function validateArtifact(value: unknown, source = 'artifact'): ArtifactV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArtifactFormatError(`${source} is not a smallchat artifact (expected a JSON object)`);
  }
  const record = value as Record<string, unknown>;

  if (!('formatVersion' in record)) {
    if ('version' in record || 'dispatchTables' in record) {
      const version = typeof record.version === 'string' ? ` (version ${record.version})` : '';
      throw new ArtifactVersionError(
        `${source} is a pre-1.0 smallchat artifact${version}, which does not record its embedder or tool schemas; ` +
        'recompile with smallchat 1.0 (`smallchat compile --source <manifests or MCP config>`).',
      );
    }
    throw new ArtifactFormatError(`${source} is not a smallchat artifact (missing formatVersion)`);
  }
  if (record.formatVersion !== ARTIFACT_FORMAT_VERSION) {
    throw new ArtifactVersionError(
      `${source} has formatVersion ${JSON.stringify(record.formatVersion)}; this smallchat reads ` +
      `formatVersion "${ARTIFACT_FORMAT_VERSION}". Recompile it with this version of smallchat.`,
    );
  }

  const validate = getSchemaValidator();
  if (!validate(value)) {
    const details = (validate.errors ?? [])
      .slice(0, 5)
      .map(e => `  ${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
      .join('\n');
    throw new ArtifactFormatError(`${source} does not match the artifact 1.0 schema:\n${details}`);
  }

  const artifact = value as ArtifactV1;
  checkConsistency(artifact, source);

  let expected: string;
  try {
    expected = computeContentHash(artifact);
  } catch (e) {
    throw new ArtifactFormatError(`${source} cannot be hashed: ${(e as Error).message}`);
  }
  if (artifact.contentHash !== expected) {
    throw new ArtifactFormatError(
      `${source} failed its content-hash check (recorded ${artifact.contentHash}, computed ${expected}); ` +
      'it was modified after compilation or is corrupt. Recompile it.',
    );
  }
  return artifact;
}

function checkConsistency(artifact: ArtifactV1, source: string): void {
  const fail = (msg: string): never => {
    throw new ArtifactFormatError(`${source} is inconsistent: ${msg}`);
  };

  for (const [key, provider] of Object.entries(artifact.providers)) {
    if (provider.id !== key) fail(`provider key "${key}" holds provider id "${provider.id}"`);
  }

  for (const [key, tool] of Object.entries(artifact.tools)) {
    if (tool.id !== key) fail(`tool key "${key}" holds tool id "${tool.id}"`);
    if (tool.id !== `${tool.providerId}/${tool.name}`) {
      fail(`tool id "${tool.id}" is not "<providerId>/<name>" (${tool.providerId}, ${tool.name})`);
    }
    if (!artifact.providers[tool.providerId]) fail(`tool ${tool.id} names unknown provider "${tool.providerId}"`);
    const primary = artifact.selectors[tool.selector];
    if (!primary || primary.toolId !== tool.id || primary.kind !== 'tool') {
      fail(`tool ${tool.id} names selector "${tool.selector}", which is not its primary selector`);
    }
  }

  for (const [key, selector] of Object.entries(artifact.selectors)) {
    if (selector.canonical !== key) fail(`selector key "${key}" holds selector "${selector.canonical}"`);
    const owner = artifact.tools[selector.toolId];
    if (!owner) fail(`selector ${key} points at unknown tool "${selector.toolId}"`);
    if (selector.kind === 'tool' && owner.selector !== key) {
      fail(`selector ${key} claims to be the primary selector of ${selector.toolId}`);
    }
    if (selector.vector.length !== artifact.embedder.dims) {
      fail(`selector ${key} has ${selector.vector.length} dimensions; the embedder has ${artifact.embedder.dims}`);
    }
  }

  const stats = artifact.stats;
  const actual = {
    toolCount: Object.keys(artifact.tools).length,
    selectorCount: Object.keys(artifact.selectors).length,
    providerCount: Object.keys(artifact.providers).length,
    collisionCount: artifact.collisions.length,
    duplicateCount: artifact.duplicates.length,
  };
  for (const [name, count] of Object.entries(actual)) {
    if (stats[name as keyof typeof stats] !== count) {
      fail(`stats.${name} is ${stats[name as keyof typeof stats]} but the artifact holds ${count}`);
    }
  }
}

/** Parse and validate artifact JSON text (rejects prototype-pollution keys). */
export function parseArtifact(text: string, source = 'artifact'): ArtifactV1 {
  let value: unknown;
  try {
    value = safeJsonParse(text);
  } catch (e) {
    throw new ArtifactFormatError(`${source} is not valid JSON: ${(e as Error).message}`);
  }
  return validateArtifact(value, source);
}

/** Serialize an artifact to its on-disk JSON form. */
export function serializeArtifact(artifact: ArtifactV1): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
