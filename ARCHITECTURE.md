# smallchat Architecture

> "The big idea is messaging." — Alan Kay

smallchat models LLM tool use as message dispatch. The LLM expresses intent. The runtime resolves it to a concrete implementation. The design mirrors the Smalltalk/Objective-C runtime: selectors, dispatch tables, forwarding chains, and method swizzling — applied to tool orchestration.

## Two tiers: the durable engine vs. the token-era optimization layer

The codebase is deliberately split in two, reflecting what lasts and what is contingent:

- **Tier 1 — the tool-inference core (durable).** Everything that turns an intent into a resolved tool: the selector table, vector index, resolution cache, confidence tiers, the serializable resolution proof, and the `verify → decompose → refine → observe` fallback chain. Its value is *selection correctness, determinism (with the same artifact, embedder and runtime state — registered classes, pins, learned preferences, feedback, cache, options — and the same LLM-verifier answers, the same intent text yields the same outcome, candidate order and proof digest; scores are quantized to 1e-4 and ties broken by tool id, so float noise below that and the order tools were registered in do not matter; other intents the process saw do not either), low latency (a cache hit is a map lookup; a novel intent costs one embedding plus a linear scan of the tool vectors — milliseconds with the ONNX embedder), and auditability* — none of which depend on the price of a token. This tier is importable on its own as `@smallchat/core/inference`.
- **Tier 2 — optimization satellites (contingent).** Compaction, output compression (RTK), knowledge pre-compilation (`memex`), CRDT memory, importance scoring, and dream recompilation. These exist to reduce token spend — pressing *today*, less so as tokens get cheap. They orbit the core and are tagged `[satellite]` in `src/index.ts`. Nothing in Tier 1 depends on them.

The guiding principle: **token bloat is today's problem that a compiler solves; tool inference is the innovation that survives a future where token costs are nominal.** The sections below describe Tier 1 in detail.

## Core Layers

```
┌─────────────────────────────────────────┐
│              ToolRuntime                │
│  dispatch("find flights", { to: "NYC"}) │
├─────────────────────────────────────────┤
│           DispatchContext               │
│  selector table · resolution cache     │
│  overload tables · dispatch policy     │
├─────────────────────────────────────────┤
│             ToolClass                   │
│  dispatch table (selector → IMP)       │
│  protocols · categories · superclass   │
├─────────────────────────────────────────┤
│     SelectorTable · VectorIndex        │
│  tool selectors · cosine lookup        │
└─────────────────────────────────────────┘
```

### Selector Table (`src/core/selector-table.ts`)

The table of compiled tool (and alias) selectors and the vector index resolution searches — analogous to `sel_registerName`. It holds tools only: a runtime intent is embedded on its own (`resolve(intent)`) and is never added to the table or the index, so what an intent resolves to cannot depend on which intents the process saw before. `searchTools()` compares quantized similarities and orders ties by id. Intents are identified by `intentKey(text)` — the full text, NFC, trimmed, whitespace-collapsed, lower-cased; `canonicalize()` (stopwords dropped) is a display form only.

### Resolution Cache (`src/core/resolution-cache.ts`)

LRU cache for resolved dispatches — analogous to `objc_msgSend`'s inline cache — keyed by `intentKey`, so only the same intent text hits (a negation or another script never does). A hit skips embedding and vector search. It stores plain HIGH/EXACT vector resolutions of ordinary tools (never pinned or destructive ones) and is flushed whenever the registry changes (`registerClass`, `unregisterClass`, `swizzle`, categories, overloads) or learning/feedback changes.

### ToolClass (`src/core/tool-class.ts`)

Groups related tools under a single provider with a dispatch table (`selector → IMP`), superclass chains for fallback resolution, and protocol conformance.

### Overload Table (`src/core/overload-table.ts`)

Maps a single selector to multiple signatures, resolved by argument types and arity. Resolution priority: exact type match > superclass match > union match > any.

### Dispatch (`src/runtime/dispatch.ts`, `src/runtime/policy.ts`)

Resolution and execution are separate:

- `runtime.resolve(intent)` chooses at most one tool and executes nothing. It returns an outcome (`resolved`, `needs-disambiguation` or `unresolved`), the chosen canonical tool id (`<providerId>/<toolName>`), the ranked candidates, and a structured proof. Candidates come from pinned phrases, learned preferences, the cache, vector and overload matches and protocol conformance, are ranked once (score, then tool id), and the chosen one passes verification and the dispatch policy.
- `runtime.dispatchById(toolId, args)` executes exactly that tool: an O(1) lookup, no embedding. MCP `tools/call` uses it.
- `runtime.dispatch(intent, args, { signal?, principal? })` is `resolve` → policy → the same execution boundary as `dispatchById`. The `signal` reaches the tool (`ToolIMP.execute(args, { signal })`); a signal that fired before execution runs nothing (`outcome: 'aborted'`).

Ranking is deterministic: every score is quantized to 1e-4 and equal scores are ordered by canonical tool id (`spec/ranking/`). An opt-in semantic rate limiter (`RuntimeOptions.rateLimiter`) keeps a window per `principal` and, when it refuses a novel intent, resolution returns `outcome: 'throttled'` with a retry-after instead of throwing.

The dispatch policy is one function evaluated on every path that can run a tool: an `exact` intent pin accepts only its pinned phrases; a destructive tool (MCP `destructiveHint`) runs only by exact id, a pinned phrase or EXACT similarity measured from the intent's own embedding; below HIGH a tool runs only after an LLM verifier approves it (`requireLLMForSubHighDispatch`, on by default). Anything refused is `needs-disambiguation`, with the candidates' tool ids.

Before anything executes, arguments are validated against the tool's `inputSchema` (JSON Schema 2020-12 or draft-07, `src/core/argument-validator.ts`) and the call is identified by its canonical call digest (`spec/call-digest/`). The proof (`src/core/proof.ts`) records the candidate table, thresholds, guards, embedder fingerprint, artifact hash, decision code, the tool that ran and the call digest, and carries a `proofDigest` over all of it except timings. Three tools check decisions after the fact (`src/runtime/replay.ts`, `explain.ts`, `decision-log.ts`): `smallchat replay` runs golden traces through `resolve()` with learning frozen; `smallchat explain` prints the candidate table with each candidate's policy verdict; and an opt-in decision log appends one hash-chained JSONL line per decision (written before the tool runs) that `replay` can verify and re-resolve against the same artifact.

### Refinement + Semantic Map (`src/runtime/refinement.ts`, `src/runtime/semantic-map.ts`)

When confidence is NONE, dispatch does not guess — it *defers*. The refinement protocol returns a `tool_refinement_needed` result: "I couldn't find an exact match. Did you mean one of these?" with the nearest candidates. Each option carries its `selectorId`.

The Semantic Map closes the loop. When the user picks an option (`runtime.resolveRefinement(originalIntent, choice)`), the choice is recorded as a learned preference — the original intent's embedding mapped to the chosen selector. Two things follow:

1. **Exact fast-path** — the same intent text (same `intentKey`) later resolves straight to the learned selector, before vector search, at the EXACT tier. The system never re-asks a question it has already been answered; a reworded or negated intent is a different question.
2. **Similarity boost** — a *similar* future intent (cosine ≥ threshold to a remembered one) gets a confidence boost toward the learned selector, scaled by similarity and how many times the mapping has been reinforced. A near-miss that would otherwise defer again is lifted into a confident dispatch.

Both paths add a `semantic_map` step to the resolution proof, so the learned influence is auditable. A learned preference never authorizes a pinned or destructive tool on its own: the dispatch policy requires the pinned phrase or EXACT similarity for those. The map is the positive-signal mirror of the observer's negative examples — recorded through explicit feedback (`runtime.feedback({ intent, toolId, correct: false })`; implicit correction inference is opt-in) — and it is serializable (`SemanticMap.toJSON()` / `fromJSON`) so a host can persist learning across sessions.

### Compiler (`src/compiler/compiler.ts`)

Parse → Embed → Link pipeline. Reads tool definitions, computes semantic embeddings, groups tools into classes, and emits a compiled artifact. Thresholds come from `CompilerOptions`, else from the project's smallchat.json `compiler` block. Optional Phase 2.5 groups similar tools with different argument signatures into semantic overload groups: they are reported in `CompilationResult.semanticOverloads` and exempt from duplicate detection, but 1.0 artifacts do not carry overload tables, so dispatch does not use them.

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

Async generators give backpressure: the tool's stream is pulled only as fast as you consume events. For cancellation, pass `{ signal }` to `dispatchStream(intent, args, { signal })` (or `dispatch(...)`, `dispatchById(...)`, `DispatchBuilder.withSignal()`/`withTimeout()`): the running tool receives an `AbortSignal` that fires when yours does, and also when you stop iterating early (`break`). A tool only stops if it honors the signal — smallchat cannot interrupt code that ignores it.

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
