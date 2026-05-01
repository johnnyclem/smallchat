/**
 * Artifact — compiled tool artifact loading and serialization helpers.
 *
 * Handles loading a ToolRuntime from either a compiled .json artifact
 * or a directory of provider manifests.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CompilationResult, ProviderManifest, ToolResult } from '../core/types.js';
import { ToolClass, ToolProxy } from '../core/tool-class.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { ToolRuntime } from '../runtime/runtime.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { SqliteVectorIndex } from '../embedding/sqlite-vector-index.js';
import { SqliteArtifactStore } from './sqlite-artifact.js';

// ---------------------------------------------------------------------------
// Serialized artifact shape
// ---------------------------------------------------------------------------

export interface SerializedArtifact {
  version: string;
  stats: {
    toolCount: number;
    uniqueSelectorCount: number;
    providerCount: number;
    collisionCount: number;
  };
  selectors: Record<
    string,
    { canonical: string; parts: string[]; arity: number; vector: number[] }
  >;
  dispatchTables: Record<
    string,
    Record<
      string,
      {
        providerId: string;
        toolName: string;
        transportType: string;
        inputSchema?: Record<string, unknown>;
        compilerHints?: Record<string, unknown>;
      }
    >
  >;
  /** Provider-level compiler hints baked into this artifact */
  providerHints?: Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Runtime loading
// ---------------------------------------------------------------------------

export async function loadRuntime(
  sourcePath: string,
): Promise<{ runtime: ToolRuntime; artifact: SerializedArtifact }> {
  const embedder = new LocalEmbedder();

  // SQLite artifact path — use SqliteVectorIndex for pre-indexed vectors
  if (sourcePath.endsWith('.db') && !isDirectory(sourcePath)) {
    const store = new SqliteArtifactStore(sourcePath);
    const artifact = store.load();

    // Use a SqliteVectorIndex backed by the same database so vectors
    // are already indexed — no re-embedding or index-build needed.
    const vectorIndex = new SqliteVectorIndex(sourcePath);
    const runtime = new ToolRuntime(vectorIndex, embedder);

    hydrateRuntime(runtime, artifact);
    store.close();
    return { runtime, artifact };
  }

  const vectorIndex = new MemoryVectorIndex();
  let artifact: SerializedArtifact;

  if (sourcePath.endsWith('.json') && !isDirectory(sourcePath)) {
    const content = readFileSync(sourcePath, 'utf-8');
    artifact = JSON.parse(content);
  } else {
    const manifests = findManifests(sourcePath);

    if (manifests.length === 0) {
      console.error(
        'No manifests found. Point to a manifest directory or compiled artifact.',
      );
      process.exit(1);
    }

    const compiler = new ToolCompiler(embedder, vectorIndex);
    const result = await compiler.compile(manifests);
    artifact = buildArtifact(result, manifests);
  }

  const runtime = new ToolRuntime(vectorIndex, embedder);
  hydrateRuntime(runtime, artifact);
  return { runtime, artifact };
}

/**
 * Hydrate a ToolRuntime from a SerializedArtifact — shared between
 * JSON and SQLite load paths.
 */
async function hydrateRuntime(runtime: ToolRuntime, artifact: SerializedArtifact): Promise<void> {
  for (const [providerId, methods] of Object.entries(artifact.dispatchTables)) {
    const toolClass = new ToolClass(providerId);

    for (const [canonical, imp] of Object.entries(
      methods as Record<
        string,
        {
          providerId: string;
          toolName: string;
          transportType: string;
          inputSchema?: Record<string, unknown>;
        }
      >,
    )) {
      const selectorData = artifact.selectors[canonical];
      if (!selectorData) continue;

      const vector = new Float32Array(selectorData.vector);
      const selector = await runtime.selectorTable.intern(vector, canonical);

      const inputSchema = imp.inputSchema ?? { type: 'object' };

      const proxy = new ToolProxy(
        imp.providerId,
        imp.toolName,
        imp.transportType as 'mcp' | 'rest' | 'local' | 'grpc',
        async () => ({
          name: imp.toolName,
          description: canonical,
          inputSchema: { type: 'object', ...inputSchema },
          arguments: [],
        }),
        {
          required: [],
          optional: [],
          validate: () => ({ valid: true, errors: [] }),
        },
      );

      toolClass.addMethod(selector, proxy);
    }

    runtime.registerClass(toolClass);
  }
}

// ---------------------------------------------------------------------------
// Manifest discovery
// ---------------------------------------------------------------------------

export function findManifests(dir: string): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];

  function walk(d: string) {
    try {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        const stat = statSync(full);
        if (stat.isFile() && entry.endsWith('.json')) {
          try {
            manifests.push(JSON.parse(readFileSync(full, 'utf-8')));
          } catch {
            /* skip invalid */
          }
        } else if (stat.isDirectory()) {
          walk(full);
        }
      }
    } catch {
      /* directory might not exist */
    }
  }

  walk(dir);
  return manifests;
}

// ---------------------------------------------------------------------------
// Artifact construction
// ---------------------------------------------------------------------------

export function buildArtifact(
  result: CompilationResult,
  manifests: ProviderManifest[],
): SerializedArtifact {
  const schemaIndex = new Map<string, Record<string, unknown>>();
  const hintIndex = new Map<string, Record<string, unknown>>();
  for (const manifest of manifests) {
    for (const tool of manifest.tools) {
      schemaIndex.set(
        tool.name,
        tool.inputSchema as unknown as Record<string, unknown>,
      );
      if (tool.compilerHints) {
        hintIndex.set(tool.name, tool.compilerHints as unknown as Record<string, unknown>);
      }
    }
  }

  const selectors: SerializedArtifact['selectors'] = {};
  for (const [key, sel] of result.selectors) {
    selectors[key] = {
      canonical: sel.canonical,
      parts: sel.parts,
      arity: sel.arity,
      vector: Array.from(sel.vector),
    };
  }

  const dispatchTables: SerializedArtifact['dispatchTables'] = {};
  for (const [providerId, table] of result.dispatchTables) {
    const methods: Record<
      string,
      {
        providerId: string;
        toolName: string;
        transportType: string;
        inputSchema?: Record<string, unknown>;
        compilerHints?: Record<string, unknown>;
      }
    > = {};
    for (const [canonical, imp] of table) {
      methods[canonical] = {
        providerId: imp.providerId,
        toolName: imp.toolName,
        transportType: imp.transportType,
        inputSchema: schemaIndex.get(imp.toolName),
        compilerHints: hintIndex.get(imp.toolName),
      };
    }
    dispatchTables[providerId] = methods;
  }

  // Collect provider-level hints
  const providerHints: Record<string, Record<string, unknown>> = {};
  for (const manifest of manifests) {
    if (manifest.compilerHints) {
      providerHints[manifest.id] = manifest.compilerHints as unknown as Record<string, unknown>;
    }
  }

  return {
    version: '0.5.0',
    stats: {
      toolCount: result.toolCount,
      uniqueSelectorCount: result.uniqueSelectorCount,
      providerCount: result.dispatchTables.size,
      collisionCount: result.collisions.length,
    },
    selectors,
    dispatchTables,
    ...(Object.keys(providerHints).length > 0 ? { providerHints } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool list & content helpers
// ---------------------------------------------------------------------------

export function buildToolList(artifact: SerializedArtifact): object[] {
  const tools: object[] = [];
  for (const [_providerId, methods] of Object.entries(
    artifact.dispatchTables,
  )) {
    for (const [canonical, imp] of Object.entries(methods)) {
      const inputSchema = imp.inputSchema ?? {
        type: 'object',
        properties: {},
      };
      tools.push({
        name: imp.toolName,
        description: `${canonical} [${imp.providerId}]`,
        inputSchema,
      });
    }
  }
  return tools;
}

export function formatContent(
  result: ToolResult,
): Array<{ type: string; text: string }> {
  const text =
    typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);
  return [{ type: 'text', text }];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
