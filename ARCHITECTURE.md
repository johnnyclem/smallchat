# smallchat Architecture

> "The big idea is messaging." — Alan Kay

smallchat models LLM tool use as message dispatch. The LLM expresses intent. The runtime resolves it to a concrete implementation. The design mirrors the Smalltalk/Objective-C runtime: selectors, dispatch tables, forwarding chains, and method swizzling — applied to tool orchestration.

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

smallchat now opens the actual provider stream. Dispatch resolves the intent once, then hands control straight to the LLM provider (OpenAI or Anthropic). Tokens arrive the moment they are generated. No waiting for the full result. The new `smallchat_dispatchStream` generator yields real deltas in real time.

### The `dispatchStream` generator

```typescript
import { ToolRuntime } from "@smallchat/core";

const runtime = new ToolRuntime(/* config with provider and model */);

async function* smallchat_dispatchStream(
  intent: string,
  args?: Record<string, unknown>,
) {
  // Resolve once (semantic match, cache hit, fallback chain)
  yield { type: "tool-start", intent };

  // Open the native provider stream
  const stream = await runtime.openProviderStream(intent, args);

  for await (const delta of stream) {
    yield { type: "token", content: delta };
  }

  yield { type: "done" };
}
```

### Consuming the stream

```typescript
for await (const event of smallchat_dispatchStream("find flights", { to: "NYC" })) {
  if (event.type === "token") {
    ui.append(event.content);
  }
}
```

That is it. One generator. Real tokens. No middleware. No callback hell.

### Why this beats a framework

| Concern | LangChain | smallchat |
|---|---|---|
| Streaming | `CallbackManager` + custom piping | `for await` over native provider deltas |
| Tool dispatch | Chain/Agent hierarchy | One `smallchat_dispatchStream` call |
| Caching | External wrappers | Built-in resolution cache |
| Extensibility | Subclass and register | `toolClass.addMethod` or swizzle |
| Bundle size | Multiple adapter packages | Single package, zero dependencies |

The runtime gives you primitives. You compose them with the language itself.

### Nested streaming

```typescript
async function* streamWithContext(intent: string) {
  const prefs = await runtime.dispatch("get user preferences");
  yield* smallchat_dispatchStream(intent, { preferences: prefs.output });
}
```

### Backpressure and cancellation

Standard async generators give it for free. `AbortController` works exactly as you expect.

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
  smallchat_dispatchStream(intent)
        │
        ▼
  for await (event of stream) { ui.append(event.content) }
```
