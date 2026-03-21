---
title: ToolCompiler
sidebar_label: ToolCompiler
---

# ToolCompiler API Reference

`ToolCompiler` runs the Parse → Embed → Overload → Link pipeline and emits a compiled artifact.

## Constructor

```typescript
import { ToolCompiler, LocalEmbedder, MemoryVectorIndex } from '@smallchat/core';

const compiler = new ToolCompiler(embedder, vectorIndex);
```

Parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `embedder` | `Embedder` | Embedding provider — use `LocalEmbedder` for zero-dependency local inference |
| `vectorIndex` | `VectorIndex` | Vector similarity index — use `MemoryVectorIndex` for in-memory |

## `compile(manifests, options?)`

Compile an array of `ProviderManifest` objects:

```typescript
import type { ProviderManifest, CompilationResult } from '@smallchat/core';

const manifests: ProviderManifest[] = [
  JSON.parse(fs.readFileSync('./tools/github-manifest.json', 'utf8')),
  JSON.parse(fs.readFileSync('./tools/slack-manifest.json', 'utf8')),
];

const result: CompilationResult = await compiler.compile(manifests, {
  overloadThreshold: 0.88,
});
```

### `CompilerOptions`

```typescript
interface CompilerOptions {
  overloadThreshold?: number;   // Default: 0.88 — similarity threshold for auto-grouping overloads
  selectorThreshold?: number;   // Default: 0.95 — deduplication threshold
  emitHeader?: boolean;         // Default: false — emit TypeScript declarations
}
```

### `CompilationResult`

```typescript
interface CompilationResult {
  artifact: CompiledArtifact;                 // the compiled output, ready to serialize
  collisions: SelectorCollision[];            // selector name conflicts
  overloadGroups: SemanticOverloadGroup[];    // auto-generated overload groups
  stats: {
    providers: number;
    tools: number;
    selectors: number;
    deduplicated: number;   // selectors that were merged
    overloads: number;
  };
}
```

## Manifest format

```typescript
import type { ProviderManifest, ToolDefinition } from '@smallchat/core';

interface ProviderManifest {
  id: string;
  name: string;
  transportType: 'mcp' | 'http' | 'local';
  description?: string;
  tools: ToolDefinition[];
}

interface ToolDefinition {
  name: string;
  description: string;
  providerId: string;
  transportType: 'mcp' | 'http' | 'local';
  inputSchema: JSONSchemaType;
}
```

## Parsers

Utilities for converting other formats to `ProviderManifest`:

### `parseMCPManifest(json)`

Parse a raw MCP server manifest (the `tools/list` response format):

```typescript
import { parseMCPManifest } from '@smallchat/core';

const manifest = parseMCPManifest(rawMCPResponse);
```

### `parseOpenAPISpec(spec)`

Parse an OpenAPI 3.x specification into a `ProviderManifest`:

```typescript
import { parseOpenAPISpec } from '@smallchat/core';

const spec = JSON.parse(fs.readFileSync('./openapi.json', 'utf8'));
const manifest = parseOpenAPISpec(spec);
```

### `parseRawSchema(schema)`

Parse a raw JSON Schema object:

```typescript
import { parseRawSchema } from '@smallchat/core';
```

## Programmatic compilation workflow

```typescript
import {
  ToolCompiler,
  LocalEmbedder,
  MemoryVectorIndex,
} from '@smallchat/core';
import * as fs from 'fs';
import * as path from 'path';

async function compileAll(sourceDir: string, outputPath: string) {
  const embedder = new LocalEmbedder();
  const vectorIndex = new MemoryVectorIndex();
  const compiler = new ToolCompiler(embedder, vectorIndex);

  // Load all manifests from the source directory
  const manifests = fs
    .readdirSync(sourceDir)
    .filter((f) => f.endsWith('-manifest.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(sourceDir, f), 'utf8')));

  const result = await compiler.compile(manifests, { overloadThreshold: 0.88 });

  // Report collisions
  for (const collision of result.collisions) {
    console.warn(`Collision: ${collision.selector} → [${collision.tools.join(', ')}]`);
  }

  // Write artifact
  fs.writeFileSync(outputPath, JSON.stringify(result.artifact, null, 2));
  console.log(`Wrote ${outputPath}`);
  console.log(`  ${result.stats.tools} tools, ${result.stats.selectors} selectors`);
}

await compileAll('./tools', './tools.json');
```
