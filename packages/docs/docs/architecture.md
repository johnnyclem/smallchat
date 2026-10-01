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
│  overload tables · pins · policy       │
├─────────────────────────────────────────┤
│             ToolClass                   │
│  dispatch table (selector → IMP)       │
│  protocols · categories · superclass   │
├─────────────────────────────────────────┤
│     SelectorTable · VectorIndex        │
│  tool selectors · cosine lookup        │
└─────────────────────────────────────────┘
```

Each layer has a focused responsibility with no upward dependencies.

### Selector Table (`src/core/selector-table.ts`)

The table of compiled tool (and alias) selectors and the vector index resolution searches — analogous to `sel_registerName`. It holds tools only: an intent is embedded on its own and never added to the table, so what an intent resolves to cannot depend on which intents the process saw before. `"search for code"` and `"find code"` are two intents that may resolve to the same tool; they never become one selector.

### Resolution Cache (`src/core/resolution-cache.ts`)

LRU cache for resolved dispatches — analogous to `objc_msgSend`'s inline cache. Hot intents skip the full vector-similarity search on repeat calls. Entries are version-tagged with provider version, model version, and schema fingerprint.

### ToolClass (`src/core/tool-class.ts`)

Groups related tools under a single provider with a dispatch table (`selector → IMP`), an optional superclass whose selectors it inherits (ranked like any other candidate), and protocol conformance.

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

Streaming is dispatch, one event at a time. `smallchat_dispatchStream` (`runtime.dispatchStream`) resolves the intent once, under the same dispatch policy as `dispatch()`, then runs the chosen tool and yields its events: `resolving` → `tool-start` → `chunk`* → `done`. When nothing runs, the stream is `resolving` → `done` with an `isError` result naming the outcome. When the tool's transport streams tokens (`supportsInference` / `executeInference`), `inference-delta` events carry them before the final `chunk`. smallchat calls no LLM provider itself: every delta comes from the tool that runs.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// Simplified from src/runtime/dispatch.ts
async function* smallchat_dispatchStream(context, intent, args, options) {
  yield { type: 'resolving', intent };

  // Resolve once (pins, cache, vector search, policy); a refusal runs nothing
  const resolution = await resolveIntent(context, intent, { args });
  if (resolution.outcome !== 'resolved') {
    yield { type: 'done', result: notRun(resolution) }; // isError, metadata.outcome
    return;
  }
  yield { type: 'tool-start', toolId: resolution.chosen, confidence: resolution.confidence };

  // The tool's own stream: token deltas if its transport has them, else chunks
  for await (const event of runChosenTool(resolution, args, options)) yield event;
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

One generator, the same policy as `dispatch()`, no middleware.

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
- Refinement (no tool chosen → choose one by tool id) = `forwardInvocation:`

### No external services

Embedding runs in-process with the bundled ONNX model (all-MiniLM-L6-v2); resolution needs no network or LLM API. `@smallchat/core` does have runtime dependencies (the MCP SDK, Ajv, ONNX Runtime, SQLite, `@shorthand/core`; see its package.json).

### MCP native

The built-in `MCPServer` runs on the official MCP SDK, which negotiates the protocol version with each client (2025-11-25 down to 2024-10-07). No glue code required to connect smallchat to Claude or any other MCP-aware client.

## Key source files

| File | Purpose |
|------|---------|
| `src/index.ts` | Public API exports |
| `src/runtime/runtime.ts` | ToolRuntime — public API |
| `src/runtime/dispatch.ts` | `toolkit_dispatch`, `smallchat_dispatchStream` |
| `src/core/selector-table.ts` | Tool selectors and vector search |
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
