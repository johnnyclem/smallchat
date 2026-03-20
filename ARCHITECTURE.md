# smallchat Architecture

> "The big idea is messaging." — Alan Kay

smallchat models LLM tool use as message dispatch. The LLM expresses intent; the runtime resolves it to a concrete implementation. The design mirrors the Smalltalk/Objective-C runtime: selectors, dispatch tables, forwarding chains, and method swizzling — applied to tool orchestration.

## Core Layers

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

### Selector Table (`src/core/selector-table.ts`)

Semantic interning of tool intents — analogous to `sel_registerName`. Natural-language intents are embedded into vectors and deduplicated so that `"search for code"` and `"find code"` resolve to the same canonical selector.

### Resolution Cache (`src/core/resolution-cache.ts`)

LRU cache for resolved dispatches — analogous to `objc_msgSend`'s inline cache. Hot intents skip the full vector-similarity search on repeat calls.

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

---

## Streaming Guide

smallchat's dispatch returns results, but the real power is streaming. Wrap `runtime.dispatch` in an async generator and you get token-by-token delivery to any UI — no framework needed.

### Basic streaming pattern

```typescript
import { ToolRuntime } from "smallchat";

async function* stream(
  runtime: ToolRuntime,
  intent: string,
  args?: Record<string, unknown>,
) {
  const result = await runtime.dispatch(intent, args);

  // Stream the result payload in chunks
  const text =
    typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output);

  const chunkSize = 64;
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
  }
}
```

### Consuming the stream

```typescript
for await (const chunk of stream(runtime, "find flights", { to: "NYC" })) {
  ui.append(chunk);
}
```

That's it. No middleware, no plugin system, no chain abstraction. An async generator and a `for await` loop.

### Why this beats a framework

| Concern | LangChain | smallchat |
|---|---|---|
| Streaming | `CallbackManager` + `handleLLMNewToken` + framework-specific `Runnable` piping | `for await (const chunk of stream(...))` |
| Tool dispatch | Chain/Agent/Tool class hierarchy with prompt templates | `runtime.dispatch(intent, args)` — one function |
| Caching | External cache wrapper or custom `Runnable` | Built-in resolution cache (LRU, confidence-gated) |
| Extensibility | Subclass `BaseTool`, register in agent config | `toolClass.addMethod(selector, imp)` — or swizzle at runtime |
| Bundle size | `langchain` + `langchain-core` + adapter packages | Single package, zero LLM-framework dependencies |

The runtime gives you primitives. You compose them with the language itself — async generators, iterators, destructuring — instead of learning a framework's abstraction vocabulary.

### Nested streaming (nested dispatch)

Because dispatch is just an async function, you can compose streams:

```typescript
async function* streamWithContext(runtime: ToolRuntime, intent: string) {
  // First resolve context
  const context = await runtime.dispatch("get user preferences");

  // Then stream the main result with context applied
  yield* stream(runtime, intent, { preferences: context.output });
}

for await (const chunk of streamWithContext(runtime, "find flights")) {
  ui.append(chunk);
}
```

### Backpressure and cancellation

Standard async generator semantics give you cancellation for free:

```typescript
const controller = new AbortController();

async function renderStream(runtime: ToolRuntime, intent: string) {
  for await (const chunk of stream(runtime, intent)) {
    if (controller.signal.aborted) break;
    ui.append(chunk);
  }
}

// Cancel from anywhere
cancelButton.onclick = () => controller.abort();
```

No `unsubscribe()`, no `teardown()`, no callback cleanup. The `break` statement tears down the generator and all upstream resources.

---

## Pipeline Overview

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
  ToolRuntime.dispatch(intent)
        │
        ▼
  for await (chunk of stream(...)) { ui.append(chunk) }
```
