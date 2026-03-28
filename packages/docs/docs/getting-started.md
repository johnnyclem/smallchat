---
title: Getting Started
sidebar_label: Getting Started
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Getting Started

Get from zero to a running dispatch in under five minutes.

## 1. Install

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```bash
npm install @smallchat/core
```

Node.js 18 or later is required.

</TabItem>
<TabItem value="swift" label="Swift">

Add to your `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/johnnyclem/smallchat-swift", from: "0.2.0"),
]
```

Then add the dependency to your target:

```swift
.target(
    name: "YourApp",
    dependencies: [
        .product(name: "SmallChat", package: "smallchat-swift"),
    ]
),
```

Requires Swift 6.0+, macOS 14+ (Sonoma), or iOS 17+.

</TabItem>
</Tabs>

## 2. Create a tool manifest

A manifest is a JSON file that describes a provider and its tools. Create a `tools/` directory and add a manifest file:

```json title="tools/github-manifest.json"
{
  "id": "github",
  "name": "GitHub",
  "transportType": "mcp",
  "tools": [
    {
      "name": "search_code",
      "description": "Search for code across GitHub repositories",
      "providerId": "github",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search query" },
          "language": { "type": "string", "description": "Language filter" },
          "repo": { "type": "string", "description": "Repository to search in" }
        },
        "required": ["query"]
      }
    },
    {
      "name": "create_issue",
      "description": "Create a new issue in a GitHub repository",
      "providerId": "github",
      "transportType": "mcp",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "body": { "type": "string" },
          "repo": { "type": "string" }
        },
        "required": ["title", "repo"]
      }
    }
  ]
}
```

The manifest format is documented in full at [Manifest Format](./manifests/format).

## 3. Compile

The `compile` command reads your manifests, generates semantic embeddings for each tool description, groups tools into dispatch classes, and emits a compiled artifact:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```bash
npx @smallchat/core compile --source ./tools --output tools.json
```

</TabItem>
<TabItem value="swift" label="Swift">

```bash
swift run smallchat compile --source ./tools
```

</TabItem>
</Tabs>

Output:

```
Compiling tools... ✓ 2 tools from 1 provider embedded.
```

The compiled artifact (`tools.json`) contains embedded vectors and the full dispatch table. Commit it alongside your code — it does not need to be rebuilt unless your tool definitions change.

## 4. Test dispatch resolution

Before integrating into your application, verify that intents resolve to the tools you expect:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```bash
npx @smallchat/core resolve tools.json "search for code"
```

</TabItem>
<TabItem value="swift" label="Swift">

```bash
swift run smallchat resolve tools.toolkit.json "search for code"
```

</TabItem>
</Tabs>

Output:

```
Matched: github.search_code (confidence: 0.98)
```

Try variations to check robustness:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```bash
npx @smallchat/core resolve tools.json "find code in a repo"
# Matched: github.search_code (confidence: 0.91)

npx @smallchat/core resolve tools.json "open a bug report"
# Matched: github.create_issue (confidence: 0.87)
```

</TabItem>
<TabItem value="swift" label="Swift">

```bash
swift run smallchat resolve tools.toolkit.json "find code in a repo"
# Matched: github.search_code (confidence: 0.91)

swift run smallchat resolve tools.toolkit.json "open a bug report"
# Matched: github.create_issue (confidence: 0.87)
```

</TabItem>
</Tabs>

## 5. Start the MCP server

smallchat includes a built-in MCP 2025-11-25 compliant server. Point any MCP client at it:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```bash
npx @smallchat/core serve --source ./tools --port 3001
```

</TabItem>
<TabItem value="swift" label="Swift">

```bash
swift run smallchat serve --source ./tools --port 3001
```

</TabItem>
</Tabs>

Output:

```
smallchat server running on http://localhost:3001 ✓
MCP discovery: http://localhost:3001/.well-known/mcp.json
```

## 6. Use the API

For programmatic use in your application:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import {
  ToolRuntime,
  ToolCompiler,
  LocalEmbedder,
  MemoryVectorIndex,
} from '@smallchat/core';
import type { RuntimeOptions } from '@smallchat/core';

// Configure the runtime
const options: RuntimeOptions = {
  selectorThreshold: 0.95,  // deduplication threshold for similar selectors
  cacheSize: 1024,           // LRU cache entries
  minConfidence: 0.85,       // minimum match confidence
};

const embedder = new LocalEmbedder();
const vectorIndex = new MemoryVectorIndex();
const runtime = new ToolRuntime({ ...options, embedder, vectorIndex });

// Load a compiled artifact
await runtime.load('./tools.json');

// Single-shot dispatch
const result = await runtime.dispatch('search for code', {
  query: 'typescript generics',
  language: 'typescript',
});
console.log(result.output);

// Streaming dispatch — tokens arrive as they are generated
for await (const event of runtime.dispatchStream('file that new issue', {
  title: 'Add dark mode',
  repo: 'myorg/myapp',
})) {
  switch (event.type) {
    case 'resolving':
      console.log(`Resolving: ${event.intent}`);
      break;
    case 'tool-start':
      console.log(`Calling: ${event.tool}`);
      break;
    case 'chunk':
      process.stdout.write(event.content);
      break;
    case 'done':
      console.log('\nComplete.');
      break;
  }
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

// Configure the runtime
let runtime = ToolRuntime(
    vectorIndex: MemoryVectorIndex(),
    embedder: LocalEmbedder()
)

// Load a compiled artifact
try await runtime.load("./tools.json")

// Single-shot dispatch
let result = try await runtime.dispatch("search for code", args: [
    "query": "typescript generics",
    "language": "typescript",
])
print(result.output)

// Streaming dispatch — tokens arrive as they are generated
for try await event in runtime.dispatchStream("file that new issue", args: [
    "title": "Add dark mode",
    "repo": "myorg/myapp",
]) {
    switch event {
    case .resolving(let intent):
        print("Resolving: \(intent)")
    case .toolStart(let toolName, _, _, _):
        print("Calling: \(toolName)")
    case .chunk(let content, _):
        print(content, terminator: "")
    case .done:
        print("\nComplete.")
    default:
        break
    }
}
```

</TabItem>
</Tabs>

## Next steps

- [What it does](./what-it-does) — understand the full dispatch pipeline
- [CLI Reference](./cli/) — all command options
- [Manifest Format](./manifests/format) — provider manifest schema
- [API Reference](./api/runtime) — full API docs
