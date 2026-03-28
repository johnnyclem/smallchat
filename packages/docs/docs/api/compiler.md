---
title: ToolCompiler
sidebar_label: ToolCompiler
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# ToolCompiler API Reference

`ToolCompiler` runs the Parse → Embed → Overload → Link pipeline and emits a compiled artifact.

## Constructor

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolCompiler, LocalEmbedder, MemoryVectorIndex } from '@smallchat/core';

const compiler = new ToolCompiler(embedder, vectorIndex);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let embedder = LocalEmbedder()
let vectorIndex = MemoryVectorIndex()
let compiler = ToolCompiler(embedder: LocalEmbedder(), vectorIndex: MemoryVectorIndex())
```

</TabItem>
</Tabs>

Parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `embedder` | `Embedder` | Embedding provider — use `LocalEmbedder` for zero-dependency local inference |
| `vectorIndex` | `VectorIndex` | Vector similarity index — use `MemoryVectorIndex` for in-memory |

## `compile(manifests, options?)`

Compile an array of `ProviderManifest` objects:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat
import Foundation

let manifests: [ProviderManifest] = [
    try JSONDecoder().decode(ProviderManifest.self, from: Data(contentsOf: URL(fileURLWithPath: "./tools/github-manifest.json"))),
    try JSONDecoder().decode(ProviderManifest.self, from: Data(contentsOf: URL(fileURLWithPath: "./tools/slack-manifest.json"))),
]

let result = try await compiler.compile(manifests, options: CompilerOptions(overloadThreshold: 0.88))
```

</TabItem>
</Tabs>

### `CompilerOptions`

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
interface CompilerOptions {
  overloadThreshold?: number;   // Default: 0.88 — similarity threshold for auto-grouping overloads
  selectorThreshold?: number;   // Default: 0.95 — deduplication threshold
  emitHeader?: boolean;         // Default: false — emit TypeScript declarations
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct CompilerOptions {
    var overloadThreshold: Double?   // Default: 0.88 — similarity threshold for auto-grouping overloads
    var selectorThreshold: Double?   // Default: 0.95 — deduplication threshold
}
```

</TabItem>
</Tabs>

### `CompilationResult`

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct CompilationResult {
    let artifact: CompiledArtifact                 // the compiled output, ready to serialize
    let collisions: [SelectorCollision]            // selector name conflicts
    let overloadGroups: [SemanticOverloadGroup]     // auto-generated overload groups
    let stats: CompilationStats
}

struct CompilationStats {
    let providers: Int
    let tools: Int
    let selectors: Int
    let deduplicated: Int   // selectors that were merged
    let overloads: Int
}
```

</TabItem>
</Tabs>

## Manifest format

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct ProviderManifest: Codable {
    let id: String
    let name: String
    let transportType: TransportType
    let description: String?
    let tools: [ToolDefinition]
}

struct ToolDefinition: Codable {
    let name: String
    let description: String
    let providerId: String
    let transportType: TransportType
    let inputSchema: JSONSchema
}

enum TransportType: String, Codable {
    case mcp, http, local
}
```

</TabItem>
</Tabs>

## Parsers

Utilities for converting other formats to `ProviderManifest`:

### `parseMCPManifest(json)`

Parse a raw MCP server manifest (the `tools/list` response format):

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { parseMCPManifest } from '@smallchat/core';

const manifest = parseMCPManifest(rawMCPResponse);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let manifest = try parseMCPManifest(rawMCPResponse)
```

</TabItem>
</Tabs>

### `parseOpenAPISpec(spec)`

Parse an OpenAPI 3.x specification into a `ProviderManifest`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { parseOpenAPISpec } from '@smallchat/core';

const spec = JSON.parse(fs.readFileSync('./openapi.json', 'utf8'));
const manifest = parseOpenAPISpec(spec);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat
import Foundation

let data = try Data(contentsOf: URL(fileURLWithPath: "./openapi.json"))
let spec = try JSONDecoder().decode(ProviderManifest.self, from: data)
let manifest = try parseOpenAPISpec(spec)
```

</TabItem>
</Tabs>

### `parseRawSchema(schema)`

Parse a raw JSON Schema object:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { parseRawSchema } from '@smallchat/core';
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat
```

</TabItem>
</Tabs>

## Programmatic compilation workflow

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat
import Foundation

let embedder = LocalEmbedder()
let vectorIndex = MemoryVectorIndex()
let compiler = ToolCompiler(embedder: embedder, vectorIndex: vectorIndex)

let sourceURL = URL(fileURLWithPath: "./tools")
let manifests = try FileManager.default.contentsOfDirectory(at: sourceURL, includingPropertiesForKeys: nil)
    .filter { $0.pathExtension == "json" }
    .map { try JSONDecoder().decode(ProviderManifest.self, from: Data(contentsOf: $0)) }

let result = try await compiler.compile(manifests, options: CompilerOptions(overloadThreshold: 0.88))

for collision in result.collisions {
    print("Collision: \(collision.selector) → \(collision.tools)")
}

let outputData = try JSONEncoder().encode(result.artifact)
try outputData.write(to: URL(fileURLWithPath: "./tools.json"))
```

</TabItem>
</Tabs>
