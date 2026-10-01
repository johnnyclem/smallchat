---
title: What it does
sidebar_label: What it does
---

# What it does

smallchat is a **message-passing tool compiler** for LLM-powered applications. It solves one specific problem: given a natural-language intent from an LLM, find and invoke the best-matching tool — reliably, fast, and without hallucination.

## The dispatch model

Resolution and execution are separate. When the LLM produces an intent like `"search for code"`, `runtime.resolve()`:

1. **Checks** pinned phrases, learned preferences and the resolution cache for this exact intent text
2. **Embeds** the intent on its own (it is never added to the SelectorTable)
3. **Searches** the tool selectors by cosine similarity, quantized and tie-broken by tool id
4. **Chooses** among overloads by the call's argument types
5. **Ranks** the candidates into confidence tiers (EXACT / HIGH / MEDIUM / LOW)
6. **Applies** intent pins, verification and the dispatch policy, and returns an outcome — `resolved` (one tool id), `needs-disambiguation` or `unresolved` — with a proof

Nothing has run yet. `runtime.dispatchById(toolId, args)` validates the arguments against the tool's JSON Schema and runs exactly that tool; `runtime.dispatch(intent, args)` does both, and runs a tool only when the policy allows it (below HIGH, only with an LLM verifier's approval). A repeated intent is served from the cache without embedding. No prompt stuffing, and no guessing: a call that ran nothing says so (`isError`, `metadata.outcome`).

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

Each tool description is embedded into a fixed-dimension vector using the configured `Embedder`. By default this is the bundled ONNX model (all-MiniLM-L6-v2), run in-process with no external API calls; the artifact records the embedder's fingerprint and refuses to load with any other.

Every tool keeps its own selector. Two distinct tools that embed at ≥ 0.95 cosine similarity are a compile error (`--allow-duplicates` keeps both and records the pair) — the compiler never merges tools.

### Overload (optional)

When multiple tools share a selector above the `overloadThreshold`, the compiler generates semantic overload groups. Resolution then factors in parameter types and arity to pick the right implementation.

### Link

The compiler assembles ToolClass objects (one per provider), builds dispatch tables (`selector → IMP`), and emits a compiled artifact (format 1.0, content-hashed). Load it with `loadRuntime('tools.toolkit.json')`.

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

// Tier 1 — token-level inference stream (yields token text)
for await (const token of runtime.inferenceStream('explain this code', { code: '...' })) {
  process.stdout.write(token);
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
- `done` — stream complete; for an intent that did not resolve to one tool, `done` comes right after `resolving` with an `isError` result and nothing runs

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

## When no tool is chosen

There is no fallback chain: smallchat never runs a weaker match on a guess.
When resolution does not choose exactly one tool, the call runs nothing and
returns an `isError` result whose `metadata.outcome` says why —
`needs-disambiguation` (candidates exist, but the dispatch policy will not
pick one on its own: below HIGH without an LLM verifier's approval, a
destructive tool below EXACT, a pinned tool) or `unresolved` (nothing
plausible matched). The result lists the candidates' tool ids; the caller
chooses one and calls it with `dispatchById`.

```typescript
const result = await runtime.dispatch('do something vague', args);
if (result.isError) {
  console.log(result.metadata?.outcome, result.content); // { error, candidates, options }
}
```
