---
title: Dispatch
sidebar_label: Dispatch
---

# Dispatch

The dispatch layer is the hot path. It takes a natural-language intent, resolves it to a concrete implementation, and invokes it — either as a single call or as a streaming generator.

## `toolkit_dispatch` — the hot path

```typescript
import { toolkit_dispatch } from '@smallchat/core';

const result = await toolkit_dispatch(context, 'search for code', {
  query: 'typescript generics',
});
```

The full resolution flow:

```
toolkit_dispatch(context, intent, args)
  │
  ├─ 1. Canonicalize intent string
  ├─ 2. Check ResolutionCache → cache hit? return IMP directly
  ├─ 3. Embed intent via context.embedder
  ├─ 4. SelectorTable.resolve() → cosine nearest-neighbor search
  ├─ 5. Walk ToolClass hierarchy (dispatch table + superclass chain)
  ├─ 6. OverloadTable.resolve(args) → best parameter signature
  ├─ 7. Invoke IMP(args)
  └─ 8. Store result in ResolutionCache
```

If step 4 finds no match above `minConfidence`, the fallback chain runs (see below). If the chain exhausts, `UnrecognizedIntent` is thrown.

## `smallchat_dispatchStream` — streaming

```typescript
import { smallchat_dispatchStream } from '@smallchat/core';

for await (const event of smallchat_dispatchStream(context, 'summarize this file', { path: './README.md' })) {
  switch (event.type) {
    case 'resolving':
      console.log('Resolving:', event.intent);
      break;
    case 'tool-start':
      console.log('Tool:', event.tool);
      break;
    case 'chunk':
      process.stdout.write(event.content);
      break;
    case 'inference-delta':
      process.stdout.write(event.token);
      break;
    case 'done':
      console.log('\nDone.');
      break;
    case 'error':
      console.error('Error:', event.message);
      break;
  }
}
```

`smallchat_dispatchStream` uses the same resolution path as `toolkit_dispatch`, then opens the native provider stream. Tokens arrive in real time as the provider generates them — no buffering, no waiting for the full result.

## `DispatchContext`

Both dispatch functions take a `DispatchContext` as their first argument. The context holds all runtime state for a dispatch:

```typescript
interface DispatchContext {
  selectorTable: SelectorTable;
  resolutionCache: ResolutionCache;
  overloadTables: Map<string, OverloadTable>;
  forwardingChain: ForwardingHandler[];
  embedder: Embedder;
  selectorThreshold: number;
  minConfidence: number;
  modelVersion?: string;
}
```

You rarely construct `DispatchContext` directly — `ToolRuntime` creates one per call and passes it through. The context is exposed for advanced use cases: testing, custom forwarding handlers, or embedding dispatch into a larger orchestration system.

## Resolution flow diagram

```
intent: "search for code"
          │
          ▼
   canonicalize → "search for code"
          │
          ▼
   ResolutionCache.get("search for code")
          │
     hit ─┴─ miss
      │         │
      ▼         ▼
  return     embed intent
  cached     │
  IMP        ▼
          SelectorTable.resolve()
          cosine similarity search
          │
     found ─┴─ not found
      │               │
      ▼               ▼
  walk ToolClass   fallback chain
  hierarchy        │
      │            ├─ superclass traversal
      ▼            ├─ broadened threshold (0.75→0.5)
  OverloadTable    └─ UnrecognizedIntent
  .resolve(args)
      │
      ▼
  invoke IMP
      │
      ▼
  cache result
      │
      ▼
  return / yield
```

## Fallback chain

When no selector matches above `minConfidence`, the `DispatchContext.forwardingChain` is consulted in order:

1. **Superclass traversal** — if the closest ToolClass has a superclass, repeat dispatch on it
2. **Broadened search** — lower the cosine threshold progressively (0.75 → 0.5) and retry
3. **LLM disambiguation** — (planned) send the intent + candidates to the LLM for disambiguation

If the chain exhausts without a match:

```typescript
import { UnrecognizedIntent } from '@smallchat/core';

try {
  await runtime.dispatch('do something completely unrelated');
} catch (e) {
  if (e instanceof UnrecognizedIntent) {
    // e.intent — the original intent string
    // e.candidates — closest matches (below threshold)
    console.error(`No tool matched "${e.intent}"`);
  }
}
```

## `FallbackStep` and `FallbackChainResult`

You can inspect the fallback chain result for diagnostics:

```typescript
import type { FallbackChainResult, FallbackStep } from '@smallchat/core';

// Each step records what was tried and why it failed
interface FallbackStep {
  strategy: 'superclass' | 'broadened' | 'llm';
  threshold?: number;
  candidates: SelectorMatch[];
  succeeded: boolean;
}

interface FallbackChainResult {
  steps: FallbackStep[];
  resolved: ResolvedTool | null;
}
```
