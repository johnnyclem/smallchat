---
title: Dispatch
sidebar_label: Dispatch
---

# Dispatch

The dispatch layer turns a natural-language intent into at most one tool
call. In 1.0 it has two halves that can be used separately:

- **Resolution** (`runtime.resolve(intent)`) chooses a tool, or refuses to,
  and explains why. It never executes anything.
- **Execution** (`runtime.dispatchById(toolId, args)`) runs exactly one
  named tool after validating its arguments.

`runtime.dispatch(intent, args)` does both, and runs a tool only when the
dispatch policy allows it. This page describes `@smallchat/core` 1.0
(TypeScript); smallchat-swift 1.0 follows the same outcomes and runs the
same conformance vectors (`spec/resolve/`). The optional shortlist judge
(step 11, `spec/judge/`) is TypeScript-only for now; smallchat-swift
decodes its decision codes and proof records.

## Resolution

```typescript
const r = await runtime.resolve('search for code', { args });
switch (r.outcome) {
  case 'resolved':             // r.chosen is the tool id; r.tier its confidence tier
    await runtime.dispatchById(r.chosen!, args, { resolutionDigest: r.proof.proofDigest });
    break;
  case 'needs-disambiguation': // candidates exist but none may run on its own
  case 'unresolved':           // nothing plausible matched
    console.log(r.reason, r.candidates.map(c => c.toolId), r.refinement?.options);
    break;
  case 'throttled':            // opt-in rate limiter; retry after r.retryAfterMs
    break;
}
```

The resolution flow, in order:

```
resolve(intent)
  │
  ├─ 1. Pinned phrase?        the intent is, verbatim, an exact pin's phrase → that tool
  ├─ 2. Learned exact intent? the user chose a tool for this intent text before → that tool
  ├─ 3. Cache                 an earlier HIGH/EXACT resolution of this intent text (no-arg calls)
  ├─ 4. Rate limit (opt-in)   per principal, before a novel intent is embedded
  ├─ 5. Embed the intent      its own vector; intents are never interned
  ├─ 6. Vector search         tool selectors ≥ LOW (MEDIUM in strict mode), quantized,
  │                           ties broken by tool id; overloads chosen by argument types
  ├─ 7. Learned similar       a bounded boost toward a tool chosen for a similar intent
  ├─ 8. Protocols             only when nothing matched by vector
  ├─ 9. Pin gate              a pinned tool is excluded for intents its pin refuses
  ├─ 10. Nothing left?        unresolved (refinement options; decomposition when dispatching)
  ├─ 11. Shortlist judge      optional (RuntimeOptions.judge): a near-tie or a below-HIGH winner;
  │                           it may pick among near-ties it could then run, never for EXACT
  │                           or for a winner the policy refuses
  ├─ 12. Verification         below HIGH (below EXACT in strict mode), every candidate gets
  │                           the same checks; an LLM verifier's (or the judge's) approval is
  │                           required by default
  └─ 13. Dispatch policy      the same rules on every path (see below)
```

The [shortlist judge](./judge.md) is off by default. When configured, an
unreachable or failing judge leaves the decision what it would be without
one (the call still waits up to the judge's timeout, the proof records the
attempt and the resolution is not cached), its verdicts are recorded in the
proof, and replay and explain never call it.

Every step is recorded in `r.proof` (candidates with scores and tiers,
exclusions, guards, thresholds, the embedder fingerprint, the artifact hash)
with a stable `proofDigest`. `runtime.explain(intent)` and
`smallchat explain` print it.

## The dispatch policy

One rule set (`evaluateDispatchPolicy`) decides whether a chosen tool may run
without the caller naming it:

1. Dispatch by exact tool id is always allowed.
2. Intent pins: an `exact` pin admits only its phrases; an `elevated` pin
   admits only a similarity, measured from the intent's own embedding, at or
   above its threshold. A pin covers every tool its selector reaches
   (overload variants and every class declaring it).
3. Destructive tools (MCP `destructiveHint: true`, or `readOnlyHint: false`
   without a `destructiveHint`) run only by exact id, a pinned phrase or
   EXACT similarity — never from the cache or a learned preference.
4. Below HIGH, a tool runs only with an LLM verifier's or the shortlist
   judge's approval (`requireLLMForSubHighDispatch`, on by default).
5. Below LOW, nothing runs.

A path the policy refuses does not fall back to another way of running the
tool: the outcome is `needs-disambiguation`, and the caller chooses a tool by
id. There is no fallback chain and no "broadened" search that executes a
weaker match.

## Execution

`dispatchById(toolId, args)` looks the tool up by its canonical id (O(1), no
embedding), validates the arguments against its `inputSchema` (JSON Schema
2020-12 by default), computes the canonical call digest, appends to the
decision log if one is configured, and only then runs it.

```typescript
const result = await runtime.dispatchById('github/search_code', { query: 'generics' });
// result.metadata.proof.ran === 'github/search_code'; result.metadata.proof.callDigest
```

## Results that ran nothing

`dispatch()` and `dispatchById()` never throw for a call that did not run.
They return `isError: true` with `metadata.outcome`:

| `metadata.outcome` | ran a tool? |
|---|---|
| `resolved` | yes (the tool's own failure is `isError: true` with this outcome) |
| `needs-disambiguation` | no — `content.candidates` / `refinement.options` carry tool ids |
| `unresolved` | no — nothing matched (or an unknown tool id) |
| `throttled` | no — see `metadata.retryAfterMs` |
| `invalid-arguments` | no — `metadata.validationErrors` |
| `aborted` | no — the signal fired before the tool started |

The fluent `execContent()` throws `DispatchError` (with `outcome`,
`candidates` and `result`) for any of these instead of returning the error
payload as content.

## Streaming

```typescript
for await (const event of runtime.dispatchStream('summarize this file', { path: './README.md' })) {
  switch (event.type) {
    case 'resolving':       console.log('Resolving:', event.intent); break;
    case 'tool-start':      console.log('Tool:', event.toolId, event.confidence); break;
    case 'chunk':           console.log(event.content); break;
    case 'inference-delta': process.stdout.write(event.delta.text); break;
    case 'done':            console.log(event.result.isError ? event.result.metadata?.outcome : 'Done.'); break;
    case 'error':           console.error(event.error); break;
  }
}
```

Streaming uses the same resolution and policy. An intent that runs nothing
goes from `resolving` straight to `done` with an `isError` result.
`dispatchStreamById(toolId, args)` streams a call by exact id.

## Refinement

When resolution does not choose a tool, `r.refinement.options` lists the
candidates (each with a `toolId`). After the user picks one,
`runtime.resolveRefinement(intent, option, args)` runs it by id and teaches
the semantic map, so the same intent text resolves to that tool next time
(a learned preference never authorizes a pinned or destructive tool).

## `DispatchContext`

`ToolRuntime` owns one `DispatchContext` (`runtime.context`): the selector
table, resolution cache, registered tool classes and their index by tool id,
intent pins, the observer and semantic map, the LLM client and the policy
options. The lower-level functions `resolveIntent(context, intent)`,
`dispatchById(context, toolId, args)`, `toolkit_dispatch(context, intent,
args)` and `smallchat_dispatchStream(context, intent, args)` take it as their
first argument; the `ToolRuntime` methods are thin wrappers over them.
