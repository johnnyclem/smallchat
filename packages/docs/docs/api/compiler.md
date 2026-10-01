---
title: ToolCompiler
sidebar_label: ToolCompiler
---

# ToolCompiler API Reference

`ToolCompiler` runs the Parse → Embed → Link pipeline over provider manifests, and `buildArtifact()` turns its result into a format 1.0 artifact: the file `smallchat compile` writes, pinned to the embedder that produced its vectors. The compiler never merges distinct tools. Two tools whose embeddings are at or above `duplicateThreshold` are a `DuplicateToolError`, unless `allowDuplicates` keeps both and reports the pair.

This page documents the TypeScript package, `@smallchat/core`. Types are in `src/core/types.ts` and `src/compiler/compiler.ts`.

## Constructor

```typescript
import { ToolCompiler, createEmbedder, MemoryVectorIndex } from '@smallchat/core';

const embedder = await createEmbedder('onnx'); // or 'hash' for tests
const compiler = new ToolCompiler(embedder, new MemoryVectorIndex(), {
  duplicateThreshold: 0.95,
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `embedder` | `Embedder` | Produces the vectors. Use `createEmbedder('onnx')` (the bundled all-MiniLM-L6-v2 model, the default for `smallchat compile`) or `'hash'`, a deterministic placeholder for tests with no semantic meaning. A custom embedder must declare a `fingerprint` for its artifact to be written and loaded. |
| `vectorIndex` | `VectorIndex` | Where the compiler indexes selectors while it links, e.g. `MemoryVectorIndex` |
| `options` | `CompilerOptions` | Optional. Options set here win over the project's smallchat.json `compiler` block. |

### `CompilerOptions`

```typescript
interface CompilerOptions {
  duplicateThreshold?: number;         // Default 0.95: cosine at or above which two tools are duplicates
  allowDuplicates?: boolean;           // Default false: keep duplicates and report them instead of throwing
  collisionThreshold?: number;         // Default 0.89: cosine at or above which selectors are reported as colliding
  generateSemanticOverloads?: boolean; // Default false: group similar tools with different argument signatures
  semanticOverloadThreshold?: number;  // Default 0.82: similarity for that grouping
  compileApps?: boolean;               // Default true when a tool declares a ui:// resource
  appVectorIndex?: VectorIndex;        // Index for the MCP Apps component compiler
  /** @deprecated Use duplicateThreshold. */
  deduplicationThreshold?: number;
}
```

## `compile(manifests, projectManifest?)`

Compiles an array of `ProviderManifest` objects. `projectManifest` is the parsed smallchat.json: its `providerHints` / `toolHints` and its `compiler` thresholds apply (constructor options win).

```typescript
import { readFileSync } from 'node:fs';
import { ToolCompiler, DuplicateToolError, createEmbedder, MemoryVectorIndex } from '@smallchat/core';
import type { ProviderManifest, CompilationResult } from '@smallchat/core';

const compiler = new ToolCompiler(await createEmbedder('onnx'), new MemoryVectorIndex());
const manifests: ProviderManifest[] = [
  JSON.parse(readFileSync('./manifests/github-manifest.json', 'utf8')),
  JSON.parse(readFileSync('./manifests/slack-manifest.json', 'utf8')),
];

try {
  const result: CompilationResult = await compiler.compile(manifests);
  console.log(`${result.toolCount} tools, ${result.uniqueSelectorCount} selectors`);
} catch (err) {
  if (err instanceof DuplicateToolError) console.error(err.pairs); // the tools that embed alike
  throw err;
}
```

It throws `DuplicateToolError` (with `pairs`) for near-duplicate tools unless `allowDuplicates`, and `SelectorConflictError` when two tools claim one selector, one tool id, or one alias phrase.

### `CompilationResult`

```typescript
interface CompilationResult {
  selectors: Map<string, ToolSelector>;                  // every selector (primary and alias), by canonical
  dispatchTables: Map<string, Map<string, ToolIMP>>;     // provider id → selector canonical → implementation
  protocols: ToolProtocol[];
  tools: CompiledToolRef[];                              // every tool, in manifest order, with its selectors
  toolCount: number;
  uniqueSelectorCount: number;                           // selectors are never shared between tools
  duplicates: DuplicateToolPair[];                       // non-empty only under allowDuplicates
  collisions: SelectorCollision[];                       // { selectorA, selectorB, similarity, hint }
  overloadTables: Map<string, OverloadTableData>;
  semanticOverloads: SemanticOverloadGroup[];            // reported only; 1.0 artifacts carry no overload tables
  appArtifact?: AppArtifact;                             // when tools declare ui:// resources
}
```

## Writing an artifact

`buildArtifact(result, manifests, fingerprint)` produces the validated `ArtifactV1` (tools keyed by `<providerId>/<toolName>` with their descriptions, schemas and annotations, provider launch specs, selectors, the embedder fingerprint and a content hash). `writeArtifact(path, artifact)` writes JSON, or SQLite for a `.db` path. `loadRuntime(path)` loads it with the embedder it records.

```typescript
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ToolCompiler,
  MemoryVectorIndex,
  buildArtifact,
  createEmbedder,
  fingerprintOf,
  writeArtifact,
} from '@smallchat/core';
import type { ProviderManifest } from '@smallchat/core';

async function compileAll(sourceDir: string, outputPath: string) {
  const embedder = await createEmbedder('onnx');
  const compiler = new ToolCompiler(embedder, new MemoryVectorIndex());

  const manifests: ProviderManifest[] = readdirSync(sourceDir)
    .filter((f) => f.endsWith('-manifest.json'))
    .map((f) => JSON.parse(readFileSync(join(sourceDir, f), 'utf8')));

  const result = await compiler.compile(manifests);
  for (const collision of result.collisions) {
    console.warn(`Selectors ${collision.selectorA} and ${collision.selectorB} collide (${collision.similarity.toFixed(3)}): ${collision.hint}`);
  }

  await writeArtifact(outputPath, buildArtifact(result, manifests, fingerprintOf(embedder)));
  console.log(`Wrote ${outputPath}: ${result.toolCount} tools, ${result.uniqueSelectorCount} selectors`);
}

await compileAll('./manifests', './tools.toolkit.json');
```

## Manifest format

```typescript
interface ProviderManifest {
  id: string;                         // provider id: the first half of every tool id
  name: string;
  transportType: 'mcp' | 'rest' | 'local' | 'grpc';
  tools: ToolDefinition[];
  endpoint?: string;
  launch?: LaunchSpec;                // how to start or reach the upstream server
  version?: string;
  compilerHints?: ProviderCompilerHints;
}

interface ToolDefinition {
  name: string;                       // the upstream tool name, verbatim
  description: string;
  inputSchema: JSONSchemaType;
  providerId: string;
  transportType: 'mcp' | 'rest' | 'local' | 'grpc';
  title?: string;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;      // MCP hints, e.g. destructiveHint
  compilerHints?: CompilerHint;       // e.g. aliases, pinSelector, exclude
}
```

See [manifest format](../manifests/format.md) for every field.

## Parsers

The parsers produce the compiler's intermediate representation, `ParsedTool[]`; `compile()` calls `parseMCPManifest` itself.

| Function | Input | Output |
|----------|-------|--------|
| `parseMCPManifest(manifest)` | a `ProviderManifest` | `ParsedTool[]`, with provider hints merged into each tool |
| `parseOpenAPISpec(spec)` | an OpenAPI 3.x document | `ParsedTool[]`, one per operation with an `operationId` |
| `parseRawSchema(definition)` | one `ToolDefinition` | a `ParsedTool` |

```typescript
import { readFileSync } from 'node:fs';
import { parseOpenAPISpec } from '@smallchat/core';

const tools = parseOpenAPISpec(JSON.parse(readFileSync('./openapi.json', 'utf8')));
console.log(tools.map((t) => t.name));
```
