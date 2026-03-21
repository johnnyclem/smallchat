---
title: What it does
sidebar_label: What it does
---

# What it does

smallchat is a **message-passing tool compiler** for LLM-powered applications. It solves one specific problem: given a natural-language intent from an LLM, find and invoke the best-matching tool — reliably, fast, and without hallucination.

## The dispatch model

At the heart of smallchat is `toolkit_dispatch`. When the LLM produces an intent like `"search for code"`, dispatch:

1. **Embeds** the intent string into a vector
2. **Searches** the SelectorTable using cosine similarity
3. **Resolves** a canonical ToolSelector (or retrieves it from the ResolutionCache)
4. **Walks** the ToolClass hierarchy to find the matching IMP
5. **Checks** the OverloadTable for the best parameter signature match
6. **Invokes** the IMP with the provided arguments

The entire hot path — after the first call — is a cache lookup plus a hash table walk. No embedding on repeat calls. No prompt stuffing. No guessing.

## The compile → embed → dispatch pipeline

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
   │ Overload  │  → Group similar tools (optional, Phase 2.5)
   └────┬──────┘
        │
        ▼
   ┌─────────┐
   │  Link    │  → Classes, dispatch tables, artifact
   └────┬─────┘
        │
        ▼
  Compiled artifact (tools.json)
        │
        ▼
  toolkit_dispatch(intent, args)
```

### Parse

The compiler reads `ProviderManifest` JSON files. Each manifest declares a provider ID, transport type, and an array of tool definitions. Each tool has a `name`, `description`, and `inputSchema` (JSON Schema).

### Embed

Each tool description is embedded into a fixed-dimension vector using the configured `Embedder`. By default, `LocalEmbedder` runs entirely in-process with no external API calls.

Semantically similar descriptions — `"search for code"` and `"find code"` — land close together in the vector space and deduplicate to the same canonical selector (controlled by `selectorThreshold`, default 0.95).

### Overload (optional)

When multiple tools share a selector above the `overloadThreshold`, the compiler generates semantic overload groups. Resolution then factors in parameter types and arity to pick the right implementation.

### Link

The compiler assembles ToolClass objects (one per provider), builds dispatch tables (`selector → IMP`), and emits a compiled artifact JSON. This artifact is loaded at runtime with `runtime.load()`.

## Streaming tiers

smallchat exposes three execution tiers depending on how much granularity you need:

| Tier | Method | Granularity |
|------|--------|-------------|
| 1 | `executeInference` | Token-level deltas from the LLM provider |
| 2 | `executeStream` | Chunk-level results from the tool |
| 3 | `execute` | Single completed result |

All three share the same dispatch path. Only the execution mode differs.

```typescript
// Tier 3 — single shot
const result = await runtime.dispatch('get user info', { userId: '123' });

// Tier 2 — chunk stream
for await (const event of runtime.dispatchStream('summarize document', { url: '...' })) {
  if (event.type === 'chunk') ui.append(event.content);
}

// Tier 1 — token-level inference stream
for await (const delta of runtime.inferenceStream('explain this code', { code: '...' })) {
  if (delta.type === 'inference-delta') process.stdout.write(delta.token);
}
```

## Stream event sequence

Every streaming dispatch produces events in this order:

```
resolving  →  tool-start  →  chunk* / inference-delta*  →  done
```

- `resolving` — dispatch has received the intent and is resolving
- `tool-start` — the resolved tool name is known, execution begins
- `chunk` / `inference-delta` — content as it arrives
- `done` — stream complete

An `error` event may appear at any point if dispatch or execution fails.

## SCObject type hierarchy

Arguments passed to tools are wrapped in the SCObject type hierarchy, which mirrors NSObject:

```
SCObject
├── SCSelector    — intent fingerprints
├── SCData        — raw binary / string data
├── SCToolReference — reference to another tool
├── SCArray       — ordered collection
└── SCDictionary  — key-value collection
```

All plain JavaScript values are auto-wrapped by `wrapValue()` before dispatch and unwrapped by `unwrapValue()` after. You can bypass auto-wrapping by passing SCObject instances directly.

```typescript
import { SCArray, SCDictionary, wrapValue } from '@smallchat/core';

const args = new SCDictionary({
  query: wrapValue('typescript generics'),
  language: wrapValue('typescript'),
});
```

## Function overloading

A single selector can map to multiple implementations with different parameter signatures. The `OverloadTable` resolves which implementation to call based on:

1. **Exact type match** — argument types exactly match the signature
2. **Superclass match** — argument types are subclasses of the declared parameter types
3. **Union match** — argument types intersect a union type
4. **Any match** — fallback if the signature accepts `any`

Arity (number of arguments) acts as a tiebreaker when type scores are equal.

## Fallback chain

When no tool matches above the `minConfidence` threshold, dispatch walks a fallback chain:

1. **Superclass traversal** — check parent ToolClass
2. **Broadened search** — lower the cosine threshold (0.75 → 0.5)
3. **LLM disambiguation** — (planned) ask the model to clarify

If the chain exhausts without a match, an `UnrecognizedIntent` error is thrown.

```typescript
try {
  await runtime.dispatch('do something vague');
} catch (e) {
  if (e instanceof UnrecognizedIntent) {
    console.log('No tool matched:', e.message);
  }
}
```
