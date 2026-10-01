---
title: ToolRuntime
sidebar_label: ToolRuntime
---

# ToolRuntime API Reference

`ToolRuntime` is the top-level class of `@smallchat/core`. It owns the
`DispatchContext` (selector table, resolution cache, registered tool classes,
intent pins, dispatch policy) and exposes resolution and execution.

This page documents the TypeScript package. smallchat-swift 1.0 follows the
same resolve and dispatch semantics (the shared conformance vectors are in
`spec/`); see its repository for the Swift API.

## Loading a runtime

Most programs start from a compiled artifact (or a directory of manifests)
with `loadRuntime`:

```typescript
import { loadRuntime } from '@smallchat/core';

const { runtime, artifact, embedder, upstreams } = await loadRuntime('./tools.toolkit.json');
// ...
await upstreams.close(); // stops stdio upstream MCP servers
```

- A `.json` or `.db` artifact is validated (schema, consistency, content
  hash) and its tools are registered. The artifact records the embedder that
  produced its vectors; `loadRuntime` constructs that embedder, and refuses
  an `options.embedder` whose fingerprint differs.
- A directory of provider manifests is compiled in-process with the default
  (ONNX) embedder, as `smallchat compile` would.
- Tools of MCP providers execute on the upstream server recorded in the
  artifact (`upstreams` holds those clients; they connect lazily).

Options: `embedder`, `runtimeOptions` (below), `providers` (load only these
provider ids), `compilerOptions` (directory sources), `upstream`.

## Constructor

```typescript
import { ToolRuntime, MemoryVectorIndex, HashEmbedder } from '@smallchat/core';
import type { RuntimeOptions } from '@smallchat/core';

const runtime = new ToolRuntime(new MemoryVectorIndex(), new HashEmbedder(), options);
```

`new ToolRuntime(vectorIndex, embedder, options?)` builds an empty runtime;
register tool classes yourself (`registerClass`). `loadRuntime` does this
for you.

### `RuntimeOptions`

| Option | Default | Meaning |
|---|---|---|
| `thresholds` | EXACT 0.95, HIGH 0.85, MEDIUM 0.75, LOW 0.60 | Confidence tiers (`spec/ranking/`) |
| `requireLLMForSubHighDispatch` | `true` | Below HIGH, run a tool only when `llmClient.microCheck` approved it; otherwise the outcome is `needs-disambiguation` |
| `llmClient` | none | Verifier, decomposer and refinement provider |
| `strict` | `false` | Verify every match below EXACT and raise the search floor to MEDIUM |
| `intentPins` | none | `IntentPinRegistry` or a list of pins (`exact` / `elevated`) |
| `treatUnannotatedAsDestructive` | `false` | Tools without MCP annotations run only by id, a pinned phrase or EXACT similarity |
| `argumentCoercion` | `'none'` | `'primitives'` coerces scalars before JSON Schema validation |
| `decisionLog` | off | Path, options or `DecisionLog`: one hash-chained JSONL line per decision, written before anything runs |
| `rateLimiter` | off | Semantic rate limiting of novel intents, per principal |
| `semanticMap` / `semanticMapOptions` | empty map | Learned refinement preferences |
| `observerOptions` | — | Dispatch observer (implicit correction inference is opt-in) |
| `maxDecompositionDepth` / `maxSubDispatches` | 2 / 16 | Bounds on LOW-tier decomposition |
| `cacheSize`, `minConfidence`, `modelVersion` | 1024, 0.85, `''` | Resolution cache |
| `artifactHash` | set by `loadRuntime` | Recorded in every proof |
| `selectorNamespace` | new | Core selector protection |

`runtimeOptionsFromPolicy(policy)` builds these from a smallchat.json
`"policy"` block, as `smallchat serve` does.

## Resolving and executing

### `runtime.resolve(intent, options?)`

Choose at most one tool for an intent. Nothing executes, and by default
nothing in the runtime changes (no caching).

```typescript
const r = await runtime.resolve('file a bug about the login page', { args });
// r.outcome: 'resolved' | 'needs-disambiguation' | 'unresolved' | 'throttled'
// r.chosen (when resolved), r.tier, r.candidates, r.reason, r.refinement, r.proof
```

`options`: `args` (used to choose among overloads), `principal`, `learn`.

### `runtime.dispatchById(toolId, args, options?)`

Run exactly the tool named by its canonical id `<providerId>/<toolName>`:
no embedding, no ranking. Arguments are validated against the tool's
`inputSchema`; invalid arguments return `isError` with
`metadata.outcome: 'invalid-arguments'` and nothing runs.

```typescript
const result = await runtime.dispatchById(r.chosen!, args, { resolutionDigest: r.proof.proofDigest });
```

`options`: `resolutionDigest` (links the call to the resolution it acts
on), `signal`, `principal`.

### `runtime.dispatch(intent, args, options?)`

Resolve and run in one call. A tool runs only when the dispatch policy
allows it; otherwise the result is `isError: true` with
`metadata.outcome` (`DispatchOutcome`: `needs-disambiguation`,
`unresolved`, `throttled`, `invalid-arguments`, `aborted`) and the
candidates' tool ids. `metadata.proof` names the tool that ran (`ran`) and
the call digest.

```typescript
const result = await runtime.dispatch('search for code', { query: 'typescript generics' });
if (result.isError) console.log(result.metadata?.outcome, result.content);
```

`options`: `signal` (aborts; the running tool receives it), `principal`.

### Fluent builder: `runtime.intent(intent)` / `runtime.dispatch(intent)`

```typescript
const content = await runtime
  .intent<{ query: string }>('search for code')
  .withArgs({ query: 'generics' })
  .withTimeout(5_000)
  .execContent<SearchResult>();
```

`exec()` returns the `ToolResult`. `execContent()` returns its content, or
throws `DispatchError` (`outcome`, `candidates`, `result`) when the result
is an error. Also `withSignal()`, `withPrincipal()`, `withMetadata()`,
`stream()`, `inferStream()` / `tokens()`, `collect()`.

### `runtime.dispatchStream(intent, args?, options?)` / `dispatchStreamById(toolId, args, options?)`

Yield `DispatchEvent`s: `resolving` → `tool-start` (`toolId`, `confidence`)
→ `chunk`* / `inference-delta`* → `done` (`result`). An intent that runs
nothing goes straight to `done` with an `isError` result.

### `runtime.inferenceStream(intent, args?, options?)`

Yield only token text (inference deltas, or the chunk content when the tool
does not stream tokens).

### `runtime.explain(intent, options?)`

Resolve without learning and explain the decision: every candidate with its
tier, MCP hints, pin state and the dispatch policy's verdict. Nothing runs.

## Refinement and feedback

- `runtime.resolveRefinement(originalIntent, choice, args?)` runs the option
  the user chose (by tool id) and teaches the semantic map, so the same
  intent resolves to that tool next time.
- `runtime.reinforceRefinement(intent, selectorId, toolId?)` records a
  preference without running anything.
- `runtime.feedback({ intent, toolId, correct, principal? })` records (or
  clears) a negative example.

## Registering tools

- `registerClass(toolClass)` / `unregisterClass(name)` — add, replace (same
  name: hot reload) or remove a provider. Cached resolutions are flushed.
- `registerCoreClass(toolClass, { swizzlable? })` — register and protect its
  selectors from shadowing.
- `registerProtocol(protocol)`, `loadCategory(category)`,
  `addOverload(toolClass, selector, signature, imp)`.
- `swizzle(toolClass, selector, newImp)` — replace an implementation
  (aliases included); returns the original IMP.
- `getTool(toolId)`, `toolIds()` — the registered tools by canonical id.

## Cache versioning

`setProviderVersion(providerId, version)`, `setModelVersion(version)`,
`updateSchemaFingerprint(toolClass)` and `invalidateOn(hook)` expire or
observe cached resolutions.

## Accessors

`intentPins`, `observer`, `semanticMap`, `decisionLog`, `strict`,
`selectorTable`, `cache`, `context`; `generateHeader()` returns an
LLM-readable capability summary.
