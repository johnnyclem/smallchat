/**
 * Artifact — load a ToolRuntime from a compiled 1.0 artifact (.json or
 * .db) or a directory of provider manifests, plus MCP tool-list helpers.
 *
 * The artifact format itself (types, writer, validating reader, embedder
 * identity) lives in src/artifact/ — see src/artifact/index.ts.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder, JSONSchemaType, ProviderManifest, ToolResult, VectorIndex } from '../core/types.js';
import { ToolClass, ToolProxy } from '../core/tool-class.js';
import { ToolCompiler, type CompilerOptions } from '../compiler/compiler.js';
import { extractArguments } from '../compiler/parser.js';
import { createSchemaConstraints } from '../core/argument-validator.js';
import { ToolRuntime, type RuntimeOptions } from '../runtime/runtime.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { safeJsonParse } from '../core/safe-json.js';
import { getTransport } from './transport.js';
import type { ArtifactV1 } from '../artifact/types.js';
import { buildArtifact } from '../artifact/format.js';
import { isSqliteArtifactPath, readArtifact } from '../artifact/io.js';
import {
  createEmbedder,
  DEFAULT_EMBEDDER_KIND,
  fingerprintOf,
  resolveArtifactEmbedder,
} from '../artifact/embedder.js';

// ---------------------------------------------------------------------------
// Runtime loading
// ---------------------------------------------------------------------------

export interface LoadRuntimeOptions {
  /**
   * Embedder to use. For an artifact it must match the artifact's embedder
   * fingerprint (EmbedderMismatchError otherwise); when omitted, the
   * embedder is constructed from the fingerprint. For a manifest
   * directory it is the embedder to compile with (default: the compile
   * default, ONNX).
   */
  embedder?: Embedder;
  /** Options for the ToolRuntime (thresholds, LLM client, …) */
  runtimeOptions?: RuntimeOptions;
  /** Compiler options when `sourcePath` is a manifest directory */
  compilerOptions?: CompilerOptions;
}

export interface LoadedRuntime {
  runtime: ToolRuntime;
  artifact: ArtifactV1;
  /** The embedder the runtime resolves intents with (matches artifact.embedder) */
  embedder: Embedder;
}

/**
 * Load a dispatch-ready ToolRuntime.
 *
 * `sourcePath` is a compiled artifact (`.json`, or `.db` for SQLite) or a
 * directory of provider manifests, which is compiled in-process with the
 * same default embedder as `smallchat compile`. Resolves only after every
 * tool class is registered; any load error (unreadable or pre-1.0
 * artifact, embedder mismatch, selector shadowing) rejects.
 */
export async function loadRuntime(
  sourcePath: string,
  options: LoadRuntimeOptions = {},
): Promise<LoadedRuntime> {
  let artifact: ArtifactV1;
  let embedder: Embedder;
  let vectorIndex: VectorIndex;

  if (isDirectory(sourcePath)) {
    const manifests = findManifests(sourcePath);
    if (manifests.length === 0) {
      throw new Error(
        `No manifests found in ${sourcePath}. Point to a manifest directory or a compiled artifact.`,
      );
    }
    embedder = options.embedder ?? await createEmbedder(DEFAULT_EMBEDDER_KIND);
    const compiler = new ToolCompiler(embedder, new MemoryVectorIndex(), options.compilerOptions);
    const result = await compiler.compile(manifests);
    artifact = buildArtifact(result, manifests, fingerprintOf(embedder));
    vectorIndex = new MemoryVectorIndex();
  } else {
    artifact = await readArtifact(sourcePath);
    embedder = await resolveArtifactEmbedder(artifact.embedder, {
      embedder: options.embedder,
      source: sourcePath,
    });
    if (isSqliteArtifactPath(sourcePath)) {
      // Search the vectors already indexed in the artifact database.
      const { SqliteVectorIndex } = await import('../embedding/sqlite-vector-index.js');
      vectorIndex = new SqliteVectorIndex(sourcePath, artifact.embedder.dims);
    } else {
      vectorIndex = new MemoryVectorIndex();
    }
  }

  const runtime = new ToolRuntime(vectorIndex, embedder, {
    ...options.runtimeOptions,
    modelVersion: options.runtimeOptions?.modelVersion ?? `${artifact.embedder.kind}:${artifact.embedder.model}`,
    artifactHash: options.runtimeOptions?.artifactHash ?? artifact.contentHash,
  });
  await hydrateRuntime(runtime, artifact);
  return { runtime, artifact, embedder };
}

/**
 * Register every provider of an artifact as a ToolClass. Each selector is
 * registered under its exact canonical — never folded into a similar one —
 * so distinct tools stay distinct at runtime too.
 */
async function hydrateRuntime(runtime: ToolRuntime, artifact: ArtifactV1): Promise<void> {
  const classes = new Map<string, ToolClass>();
  for (const providerId of Object.keys(artifact.providers)) {
    classes.set(providerId, new ToolClass(providerId));
  }

  const proxies = new Map<string, ToolProxy>();
  for (const selectorData of Object.values(artifact.selectors)) {
    const tool = artifact.tools[selectorData.toolId];
    const selector = runtime.selectorTable.register(
      Float32Array.from(selectorData.vector),
      selectorData.canonical,
    );

    let proxy = proxies.get(tool.id);
    if (!proxy) {
      const launch = artifact.providers[tool.providerId].launch;
      const specs = extractArguments(tool.inputSchema as unknown as JSONSchemaType);
      proxy = new ToolProxy(
        tool.providerId,
        tool.name,
        tool.transportType,
        async () => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as unknown as JSONSchemaType,
          arguments: specs,
        }),
        createSchemaConstraints(tool.inputSchema, specs),
        launch && launch.transport !== 'stdio' ? { endpoint: launch.url } : undefined,
        getTransport,
      );
      proxy.annotations = tool.annotations;
      proxies.set(tool.id, proxy);
    }

    classes.get(tool.providerId)!.addMethod(selector, proxy);
  }

  for (const toolClass of classes.values()) {
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
            manifests.push(safeJsonParse(readFileSync(full, 'utf-8')) as ProviderManifest);
          } catch {
            /* skip invalid (including prototype-pollution payloads) */
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
// Tool list & content helpers
// ---------------------------------------------------------------------------

/**
 * MCP tools/list entries for every tool in the artifact, carrying the
 * upstream description, inputSchema, outputSchema, annotations and title.
 */
export function buildToolList(artifact: ArtifactV1): object[] {
  return Object.values(artifact.tools).map(tool => ({
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  }));
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
