---
title: Dispatch
sidebar_label: Dispatch
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Dispatch

The dispatch layer is the hot path. It takes a natural-language intent, resolves it to a concrete implementation, and invokes it — either as a single call or as a streaming generator.

## `toolkit_dispatch` — the hot path

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { toolkit_dispatch } from '@smallchat/core';

const result = await toolkit_dispatch(context, 'search for code', {
  query: 'typescript generics',
});
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let result = try await toolkitDispatch(context, "search for code", args: [
  "query": "typescript generics",
])
```

</TabItem>
</Tabs>

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

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

for try await event in smallchatDispatchStream(context, "summarize this file", args: ["path": "./README.md"]) {
  switch event {
    case .resolving(let intent):
      print("Resolving: \(intent)")
    case .toolStart(let tool):
      print("Tool: \(tool)")
    case .chunk(let content, _):
      print(content, terminator: "")
    case .inferenceDelta(let token, _):
      print(token, terminator: "")
    case .done:
      print("\nDone.")
    case .error(let message, _):
      print("Error: \(message)")
  }
}
```

</TabItem>
</Tabs>

`smallchat_dispatchStream` uses the same resolution path as `toolkit_dispatch`, then opens the native provider stream. Tokens arrive in real time as the provider generates them — no buffering, no waiting for the full result.

## `DispatchContext`

Both dispatch functions take a `DispatchContext` as their first argument. The context holds all runtime state for a dispatch:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct DispatchContext {
  var selectorTable: SelectorTable
  var resolutionCache: ResolutionCache
  var overloadTables: [String: OverloadTable]
  var forwardingChain: [ForwardingHandler]
  var embedder: Embedder
  var selectorThreshold: Double
  var minConfidence: Double
  var modelVersion: String?
}
```

</TabItem>
</Tabs>

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

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

do {
  try await runtime.dispatch("do something completely unrelated")
} catch let error as UnrecognizedIntent {
  // error.intent — the original intent string
  // error.candidates — closest matches (below threshold)
  print("No tool matched \"\(error.intent)\"")
}
```

</TabItem>
</Tabs>

## `FallbackStep` and `FallbackChainResult`

You can inspect the fallback chain result for diagnostics:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

// Each step records what was tried and why it failed
struct FallbackStep {
  var strategy: FallbackStrategy // .superclass, .broadened, .llm
  var threshold: Double?
  var candidates: [SelectorMatch]
  var succeeded: Bool
}

struct FallbackChainResult {
  var steps: [FallbackStep]
  var resolved: ResolvedTool?
}
```

</TabItem>
</Tabs>
