---
title: Architecture
sidebar_label: Architecture
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Architecture

> "The big idea is messaging." — Alan Kay

smallchat models LLM tool use as message dispatch. The LLM expresses intent. The runtime resolves it to a concrete implementation. The design mirrors the Smalltalk/Objective-C runtime: selectors, dispatch tables, forwarding chains, and method swizzling — applied to tool orchestration.

## Core layers

```
┌─────────────────────────────────────────┐
│              ToolRuntime                │
│  dispatch("find flights", { to: "NYC"}) │
├─────────────────────────────────────────┤
│           DispatchContext               │
│  selector table · resolution cache     │
│  overload tables · forwarding chain    │
├─────────────────────────────────────────┤
│             ToolClass                   │
│  dispatch table (selector → IMP)       │
│  protocols · categories · superclass   │
├─────────────────────────────────────────┤
│     SelectorTable · VectorIndex        │
│  semantic interning · cosine lookup    │
└─────────────────────────────────────────┘
```

Each layer has a focused responsibility with no upward dependencies.

### Selector Table (`src/core/selector-table.ts`)

Semantic interning of tool intents — analogous to `sel_registerName`. Natural-language intents are embedded into vectors and deduplicated so that `"search for code"` and `"find code"` resolve to the same canonical selector.

### Resolution Cache (`src/core/resolution-cache.ts`)

LRU cache for resolved dispatches — analogous to `objc_msgSend`'s inline cache. Hot intents skip the full vector-similarity search on repeat calls. Entries are version-tagged with provider version, model version, and schema fingerprint.

### ToolClass (`src/core/tool-class.ts`)

Groups related tools under a single provider with a dispatch table (`selector → IMP`), superclass chains for fallback resolution, and protocol conformance.

### Overload Table (`src/core/overload-table.ts`)

Maps a single selector to multiple signatures, resolved by argument types and arity. Resolution priority: exact type match > superclass match > union match > any.

### Dispatch (`src/runtime/dispatch.ts`)

The hot path. `toolkit_dispatch(context, intent, args)` embeds the intent, searches the selector table, walks the class hierarchy, checks overloads, and invokes the resolved IMP.

### Compiler (`src/compiler/compiler.ts`)

Parse → Embed → Link pipeline. Reads tool definitions, computes semantic embeddings, groups tools into classes, and emits a compiled artifact. Optional Phase 2.5 generates semantic overloads by grouping tools above a similarity threshold.

### SCObject System (`src/core/sc-object.ts`)

NSObject-inspired base class for typed parameter passing. Enables runtime type checking (`isKindOfClass`, `isMemberOfClass`) and auto-wrapping of plain values into `SCData`, `SCArray`, etc.

## Pipeline overview

```
Tool definitions (JSON/YAML)
        │
        ▼
   ┌─────────┐
   │  Parse   │  → ToolProvider[] with schemas
   └────┬─────┘
        │
        ▼
   ┌─────────┐
   │  Embed   │  → Selectors get vector embeddings
   └────┬─────┘
        │
        ▼
   ┌──────────┐
   │ Overload  │  → Group similar tools (optional)
   └────┬──────┘
        │
        ▼
   ┌─────────┐
   │  Link    │  → Classes, dispatch tables, artifact
   └────┬─────┘
        │
        ▼
  Compiled artifact (JSON)
        │
        ▼
  smallchat_dispatchStream(intent)
        │
        ▼
  for await (event of stream) { ui.append(event.content) }
```

## Streaming architecture

smallchat opens the actual provider stream. Dispatch resolves the intent once, then hands control straight to the LLM provider (OpenAI or Anthropic). Tokens arrive the moment they are generated. No waiting for the full result.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
async function* smallchat_dispatchStream(context, intent, args) {
  yield { type: 'resolving', intent };

  // Resolve once — semantic match, cache hit, or fallback chain
  const resolved = await resolveIntent(context, intent);
  yield { type: 'tool-start', tool: resolved.name };

  // Open the native provider stream
  for await (const delta of resolved.implementation.stream(args)) {
    yield { type: 'chunk', content: delta };
  }

  yield { type: 'done' };
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
func smallchatDispatchStream(
    _ context: DispatchContext,
    intent: String,
    args: [String: Any]
) -> AsyncThrowingStream<DispatchEvent, Error> {
    AsyncThrowingStream { continuation in
        Task {
            continuation.yield(.resolving(intent: intent))

            let resolved = try await resolveIntent(context, intent)
            continuation.yield(.toolStart(tool: resolved.name, provider: resolved.provider, confidence: resolved.confidence, metadata: nil))

            for try await delta in resolved.implementation.stream(args) {
                continuation.yield(.chunk(content: delta, metadata: nil))
            }

            continuation.yield(.done(result: nil))
            continuation.finish()
        }
    }
}
```

</TabItem>
</Tabs>

One generator. Real tokens. No middleware.

## Design philosophy

### Primitives, not a framework

smallchat provides one well-defined primitive — the dispatch layer — and gets out of the way. It does not own your agent loop, your memory, your prompts, or your UI. You compose primitives with the language itself.

### The Obj-C runtime as a model

The Objective-C runtime solved the same problem in 1984: given a message (intent) and a receiver (tool provider), find the right method (implementation) fast. It did it with:

- A **SEL** (selector) that uniquely identifies a method by name
- A **dispatch table** per class for O(1) method lookup
- An **inline cache** to make repeat sends nearly free
- A **forwarding mechanism** for unrecognized messages

smallchat applies each of these directly:
- `ToolSelector` = SEL, but resolved by semantic embedding rather than exact string
- `ToolClass.dispatchTable` = objc class dispatch table
- `ResolutionCache` = inline method cache
- Fallback chain = `forwardInvocation:`

### Zero dependencies

`@smallchat/core` ships under 5 MB with zero runtime dependencies. Embedding runs in-process. You add what you need.

### MCP native

The built-in `MCPServer` speaks MCP 2025-11-25 out of the box. No glue code required to connect smallchat to Claude, GPT-4, or any other MCP-aware client.

## Key source files

| File | Purpose |
|------|---------|
| `src/index.ts` | Public API exports |
| `src/runtime/runtime.ts` | ToolRuntime — public API |
| `src/runtime/dispatch.ts` | `toolkit_dispatch`, `smallchat_dispatchStream` |
| `src/core/selector-table.ts` | Semantic interning |
| `src/core/resolution-cache.ts` | LRU dispatch cache |
| `src/core/tool-class.ts` | ToolClass, ToolProxy |
| `src/core/overload-table.ts` | Multi-signature dispatch |
| `src/core/sc-object.ts` | SCObject hierarchy |
| `src/core/sc-types.ts` | Type system |
| `src/core/types.ts` | Shared type definitions |
| `src/compiler/compiler.ts` | Parse → Embed → Link |
| `src/compiler/parser.ts` | Manifest parsers |
| `src/embedding/local-embedder.ts` | Local embedding |
| `src/embedding/memory-vector-index.ts` | In-memory vector index |
| `src/mcp/index.ts` | MCPServer |
| `src/cli/index.ts` | CLI entrypoint |
