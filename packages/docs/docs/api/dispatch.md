---
title: Dispatch API
sidebar_label: Dispatch API
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Dispatch API

The low-level dispatch API. These are the functions that `ToolRuntime` calls internally. You can use them directly if you want to manage `DispatchContext` yourself.

## `toolkit_dispatch(context, intent, args?)`

The hot-path dispatch function:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { toolkit_dispatch, DispatchContext } from '@smallchat/core';

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

Parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `context` | `DispatchContext` | Runtime state: selector table, cache, overloads, forwarding chain |
| `intent` | `string` | Natural-language intent string |
| `args` | `Record<string, unknown> \| SCDictionary` | Optional arguments |

Returns `ToolResult`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
interface ToolResult {
  output: unknown;
  metadata?: Record<string, unknown>;
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct ToolResult {
    let output: Any
    let metadata: [String: Any]?
}
```

</TabItem>
</Tabs>

## `smallchat_dispatchStream(context, intent, args?)`

The streaming dispatch generator:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { smallchat_dispatchStream } from '@smallchat/core';

for await (const event of smallchat_dispatchStream(context, 'summarize document', args)) {
  // handle DispatchEvent
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

for try await event in smallchatDispatchStream(context, "summarize document", args: args) {
    // handle DispatchEvent
}
```

</TabItem>
</Tabs>

Returns `AsyncGenerator<DispatchEvent>`.

## `DispatchContext`

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
interface DispatchContext {
  selectorTable: SelectorTable;
  resolutionCache: ResolutionCache;
  overloadTables: Map<string, OverloadTable>;
  forwardingChain: ForwardingHandler[];
  embedder: Embedder;
  selectorThreshold: number;    // cosine similarity threshold for deduplication
  minConfidence: number;        // minimum match confidence for a successful dispatch
  modelVersion?: string;        // for cache versioning
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct DispatchContext {
    let selectorTable: SelectorTable
    let resolutionCache: ResolutionCache
    let overloadTables: [String: OverloadTable]
    let forwardingChain: [ForwardingHandler]
    let embedder: Embedder
    let selectorThreshold: Double    // cosine similarity threshold for deduplication
    let minConfidence: Double        // minimum match confidence for a successful dispatch
    let modelVersion: String?        // for cache versioning
}
```

</TabItem>
</Tabs>

`DispatchContext` is created by `ToolRuntime` for each call. Construct it manually for custom dispatch pipelines:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import {
  DispatchContext,
  SelectorTable,
  ResolutionCache,
  LocalEmbedder,
  MemoryVectorIndex,
} from '@smallchat/core';

const context: DispatchContext = {
  selectorTable: new SelectorTable(new LocalEmbedder(), new MemoryVectorIndex()),
  resolutionCache: new ResolutionCache({ maxSize: 512 }),
  overloadTables: new Map(),
  forwardingChain: [],
  embedder: new LocalEmbedder(),
  selectorThreshold: 0.95,
  minConfidence: 0.85,
};
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let context = DispatchContext(
    selectorTable: SelectorTable(LocalEmbedder(), MemoryVectorIndex()),
    resolutionCache: ResolutionCache(maxSize: 512),
    overloadTables: [:],
    forwardingChain: [],
    embedder: LocalEmbedder(),
    selectorThreshold: 0.95,
    minConfidence: 0.85,
    modelVersion: nil
)
```

</TabItem>
</Tabs>

## `UnrecognizedIntent`

Thrown when dispatch fails to find a match above `minConfidence`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { UnrecognizedIntent } from '@smallchat/core';

try {
  await toolkit_dispatch(context, 'completely unrelated intent');
} catch (e) {
  if (e instanceof UnrecognizedIntent) {
    console.error('No match for:', e.intent);
    console.error('Best candidates:', e.candidates);
  }
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

do {
    try await toolkitDispatch(context, "completely unrelated intent")
} catch let error as UnrecognizedIntent {
    print("No match for:", error.intent)
    print("Best candidates:", error.candidates)
}
```

</TabItem>
</Tabs>

Properties:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
class UnrecognizedIntent extends Error {
  intent: string;                         // the original intent string
  candidates: SelectorMatch[];            // below-threshold candidates
  fallbackResult: FallbackChainResult;    // what the fallback chain tried
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct UnrecognizedIntent: Error {
    let intent: String                          // the original intent string
    let candidates: [SelectorMatch]             // below-threshold candidates
    let fallbackResult: FallbackChainResult     // what the fallback chain tried
}
```

</TabItem>
</Tabs>

## `DispatchEvent` types

All events yielded by `smallchat_dispatchStream`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// Dispatch has received the intent and started resolving
{ type: 'resolving'; intent: string }

// The resolved tool is known, execution begins
{ type: 'tool-start'; tool: string; provider: string }

// A result chunk from the tool
{ type: 'chunk'; content: string }

// A token-level delta from LLM inference
{ type: 'inference-delta'; token: string }

// Execution complete
{ type: 'done'; result?: ToolResult }

// An error occurred — no further events
{ type: 'error'; message: string; cause?: unknown }
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
enum DispatchEvent {
    // Dispatch has received the intent and started resolving
    case resolving(intent: String)

    // The resolved tool is known, execution begins
    case toolStart(tool: String, provider: String, confidence: Double, metadata: [String: Any]?)

    // A result chunk from the tool
    case chunk(content: String, metadata: [String: Any]?)

    // A token-level delta from LLM inference
    case inferenceDelta(delta: InferenceDelta, metadata: [String: Any]?)

    // Execution complete
    case done(result: ToolResult?)

    // An error occurred — no further events
    case error(message: String, cause: Error?)
}
```

</TabItem>
</Tabs>

## `SelectorMatch`

Returned in `UnrecognizedIntent.candidates` and fallback diagnostics:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
interface SelectorMatch {
  selector: ToolSelector;
  toolClass: string;
  tool: string;
  confidence: number;   // cosine similarity, 0–1
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct SelectorMatch {
    let selector: ToolSelector
    let toolClass: String
    let tool: String
    let confidence: Double   // cosine similarity, 0–1
}
```

</TabItem>
</Tabs>
