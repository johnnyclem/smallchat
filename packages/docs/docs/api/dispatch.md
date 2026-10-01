---
title: Dispatch API
sidebar_label: Dispatch API
---

# Dispatch API

The low-level dispatch functions behind `ToolRuntime`'s methods. Each takes
the runtime's `DispatchContext` (`runtime.context`) as its first argument.
This page documents `@smallchat/core` 1.0 (TypeScript); the concepts are in
[Dispatch](../concepts/dispatch).

## `resolveIntent(context, intent, options?)`

Choose at most one tool for an intent. Never executes. Same as
`runtime.resolve()`.

```typescript
import { resolveIntent } from '@smallchat/core';

const r = await resolveIntent(runtime.context, 'search for code', { args: { query: 'generics' } });
```

Options: `args` (overload choice and verification), `principal` (rate
limiting and feedback scope), `learn` (default `false`: cache nothing).

Returns a `Resolution`:

```typescript
interface Resolution {
  outcome: 'resolved' | 'needs-disambiguation' | 'unresolved' | 'throttled';
  intent: string;
  tier: 'exact' | 'high' | 'medium' | 'low' | 'none';
  chosen?: string;               // canonical tool id, when resolved
  confidence?: number;
  candidates: ResolutionCandidate[]; // eligible candidates, best first
  proof: ResolutionProof;        // full decision record, with proofDigest
  reason?: string;               // why no tool was chosen
  refinement?: ToolRefinementNeeded; // options, each with a toolId
  retryAfterMs?: number;         // throttled
}
```

## `dispatchById(context, toolId, args, options?)`

Run exactly the tool with canonical id `<providerId>/<toolName>`. No
embedding, no ranking; the arguments are validated against the tool's
`inputSchema` before it runs. Same as `runtime.dispatchById()`.

```typescript
import { dispatchById } from '@smallchat/core';

const result = await dispatchById(runtime.context, 'github/search_code', { query: 'generics' }, {
  resolutionDigest: r.proof.proofDigest, // optional: link to the resolution acted on
});
```

Options: `resolutionDigest`, `signal`, `principal`.

## `toolkit_dispatch(context, intent, args?, options?)`

Resolve and run in one call, applying the dispatch policy; decomposes
LOW-tier intents when the `LLMClient` supports it. Same as
`runtime.dispatch(intent, args)`.

```typescript
import { toolkit_dispatch } from '@smallchat/core';

const result = await toolkit_dispatch(runtime.context, 'search for code', { query: 'generics' });
```

Options: `signal`, `principal`.

## `ToolResult`

```typescript
interface ToolResult {
  content: unknown;
  isError?: boolean;
  metadata?: Record<string, unknown>; // outcome, toolId, tier, proof, callDigest, …
  refinement?: ToolRefinementNeeded;
}
```

A result that ran nothing is `isError: true`; `metadata.outcome` is a
`DispatchOutcome`:

```typescript
type DispatchOutcome =
  | 'resolved'              // a tool ran (its own failure is isError with this outcome)
  | 'needs-disambiguation'  // candidates exist; choose one by id
  | 'unresolved'            // nothing matched, or an unknown tool id
  | 'throttled'             // the opt-in rate limiter refused; see metadata.retryAfterMs
  | 'invalid-arguments'     // the arguments failed the inputSchema
  | 'aborted'               // the signal fired before the tool started
  | 'not-dispatched';       // a decomposition sub-intent past maxSubDispatches
```

`metadata.proof.ran` names the tool that executed (or `null`) and
`metadata.proof.callDigest` the canonical call digest
(`spec/call-digest/`).

## `DispatchError`

Thrown by `DispatchBuilder.execContent()` for an `isError` result:

```typescript
import { DispatchError } from '@smallchat/core';

try {
  const content = await runtime.intent('search for code').withArgs(args).execContent<Hits>();
} catch (e) {
  if (e instanceof DispatchError) {
    console.log(e.outcome, e.candidates, e.result);
  }
}
```

## `smallchat_dispatchStream(context, intent, args?, options?)` / `smallchat_dispatchStreamById(context, toolId, args?, options?)`

Streaming variants. Return `AsyncGenerator<DispatchEvent>`:

```typescript
{ type: 'resolving'; intent: string }
{ type: 'tool-start'; toolId: string; toolName: string; providerId: string; confidence: number; selector: string }
{ type: 'chunk'; content: unknown; index: number }
{ type: 'inference-delta'; delta: InferenceDelta; tokenIndex: number }   // delta.text is the token
{ type: 'done'; result: ToolResult }
{ type: 'error'; error: string; metadata?: Record<string, unknown> }
// plus ui-available / ui-ready / ui-update / ui-interaction for MCP Apps
```

An intent that runs nothing yields `resolving`, then `done` with an
`isError` result.

## `DispatchContext`

Created by `ToolRuntime` (one per runtime, `runtime.context`). Construct it
directly only for custom pipelines:

```typescript
import { DispatchContext, SelectorTable, ResolutionCache, MemoryVectorIndex, HashEmbedder } from '@smallchat/core';

const index = new MemoryVectorIndex();
const embedder = new HashEmbedder();
const context = new DispatchContext(
  new SelectorTable(index, embedder),
  new ResolutionCache(),
  index,
  embedder,
  undefined,              // SelectorNamespace
  undefined,              // IntentPinRegistry
  { requireLLMForSubHighDispatch: true }, // DispatchConfig
);
```

Useful members: `registerClass()`, `unregisterClass()`, `getTool(toolId)`,
`toolIds()`, `getClasses()`, `reindex()`, `intentPins`, `semanticMap`,
`observer`, `policyOptions`.

## `UnrecognizedIntent` (deprecated)

1.0 never throws `UnrecognizedIntent`: an intent that matches nothing is a
result with `metadata.outcome: 'unresolved'`. The class is still exported
for code that checks `instanceof` and will be removed in a later major
version. The 0.x fallback chain (`DispatchContext.forward()`,
`FallbackStep`, `FallbackChainResult`) is removed.
