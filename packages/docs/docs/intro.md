---
title: Introduction
sidebar_label: Introduction
slug: /intro
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Introduction

> "The big idea is messaging." — Alan Kay

smallchat is a message-passing tool compiler for LLM-powered applications. It models LLM tool use as **message dispatch** — the same mechanism that powers the Smalltalk and Objective-C runtimes. Tool intent arrives as natural language. The runtime resolves it to a concrete implementation.

## The big idea

Modern AI applications have a tool problem. You have dozens of tools across multiple providers. The LLM generates an intent — "search for code" — and something has to figure out which tool to call with what arguments. Most frameworks solve this with string matching, hand-crafted routing tables, or by dumping all tool schemas into a prompt and hoping the model picks the right one.

smallchat takes a different approach: **semantic dispatch**.

Intent strings are embedded into vectors at compile time. At runtime, `toolkit_dispatch` embeds the incoming intent, does a cosine similarity search across the selector table, and routes to the best-matching implementation. Repeated dispatches hit an LRU cache and skip the embedding entirely.

## The Obj-C runtime metaphor

If you have ever written Objective-C, the model is immediately familiar:

| Smalltalk / Obj-C | smallchat |
|---|---|
| Object | ToolProvider (MCP server, API, local function) |
| Class | ToolClass (group of related tools) |
| SEL | ToolSelector (semantic fingerprint of intent) |
| IMP | ToolIMP (concrete implementation) |
| Method = SEL + IMP | ToolMethod |
| Message send | `toolkit_dispatch(context, intent, args)` |
| Message stream | `smallchat_dispatchStream(context, intent, args)` |
| Method cache | Resolution cache (intent → resolved tool, version-tagged) |
| Protocol | ToolProtocol (capability interface) |
| Category | ToolCategory (capability extension) |
| `respondsToSelector:` | `canHandle(selector)` |
| `forwardInvocation:` | Fallback chain (superclass → broadened → LLM) |
| NSProxy | ToolProxy (lazy schema loading) |
| NSObject | SCObject (typed parameter hierarchy) |

If you have not, the model is still straightforward: tools are grouped into classes, classes respond to selectors (intent fingerprints), and dispatch walks the class hierarchy until it finds a match.

## Install

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```bash
npm install @smallchat/core
```

Package: `@smallchat/core` — version `0.5.0`

</TabItem>
<TabItem value="swift" label="Swift">

Add to your `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/johnnyclem/smallchat-swift", from: "0.2.0"),
]
```

Requires Swift 6.0+, macOS 14+, or iOS 17+.

</TabItem>
</Tabs>

## First dispatch

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolRuntime, LocalEmbedder, MemoryVectorIndex } from '@smallchat/core';

const embedder = new LocalEmbedder();
const vectorIndex = new MemoryVectorIndex();
const runtime = new ToolRuntime({ embedder, vectorIndex });

// Load a compiled artifact
await runtime.load('./tools.json');

// Dispatch natural-language intent
const result = await runtime.dispatch('search for code', { query: 'typescript generics' });
console.log(result.output);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let runtime = ToolRuntime(
    vectorIndex: MemoryVectorIndex(),
    embedder: LocalEmbedder()
)

// Load a compiled artifact
try await runtime.load("./tools.json")

// Dispatch natural-language intent
let result = try await runtime.dispatch("search for code", args: ["query": "typescript generics"])
print(result.output)
```

</TabItem>
</Tabs>

## Streaming dispatch

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
for await (const event of runtime.dispatchStream('search for code', { query: 'react hooks' })) {
  if (event.type === 'chunk') process.stdout.write(event.content);
  if (event.type === 'done') console.log('\nDone.');
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
for try await event in runtime.dispatchStream("search for code", args: ["query": "react hooks"]) {
    switch event {
    case .chunk(let content, _):
        print(content, terminator: "")
    case .done:
        print("\nDone.")
    default:
        break
    }
}
```

</TabItem>
</Tabs>

## Next steps

- **[Getting Started](./getting-started)** — install, compile, and run your first dispatch
- **[What it does](./what-it-does)** — the compile → embed → dispatch pipeline in detail
- **[Why it matters](./why-it-matters)** — the problem smallchat solves, and why this approach works
- **[Deep Dive](./concepts/)** — internals: SelectorTable, ResolutionCache, OverloadTable, streaming, swizzling
