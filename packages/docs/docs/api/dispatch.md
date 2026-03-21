---
title: Dispatch API
sidebar_label: Dispatch API
---

# Dispatch API

The low-level dispatch API. These are the functions that `ToolRuntime` calls internally. You can use them directly if you want to manage `DispatchContext` yourself.

## `toolkit_dispatch(context, intent, args?)`

The hot-path dispatch function:

```typescript
import { toolkit_dispatch, DispatchContext } from '@smallchat/core';

const result = await toolkit_dispatch(context, 'search for code', {
  query: 'typescript generics',
});
```

Parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `context` | `DispatchContext` | Runtime state: selector table, cache, overloads, forwarding chain |
| `intent` | `string` | Natural-language intent string |
| `args` | `Record<string, unknown> \| SCDictionary` | Optional arguments |

Returns `ToolResult`:

```typescript
interface ToolResult {
  output: unknown;
  metadata?: Record<string, unknown>;
}
```

## `smallchat_dispatchStream(context, intent, args?)`

The streaming dispatch generator:

```typescript
import { smallchat_dispatchStream } from '@smallchat/core';

for await (const event of smallchat_dispatchStream(context, 'summarize document', args)) {
  // handle DispatchEvent
}
```

Returns `AsyncGenerator<DispatchEvent>`.

## `DispatchContext`

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

`DispatchContext` is created by `ToolRuntime` for each call. Construct it manually for custom dispatch pipelines:

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

## `UnrecognizedIntent`

Thrown when dispatch fails to find a match above `minConfidence`:

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

Properties:

```typescript
class UnrecognizedIntent extends Error {
  intent: string;                         // the original intent string
  candidates: SelectorMatch[];            // below-threshold candidates
  fallbackResult: FallbackChainResult;    // what the fallback chain tried
}
```

## `DispatchEvent` types

All events yielded by `smallchat_dispatchStream`:

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

## `SelectorMatch`

Returned in `UnrecognizedIntent.candidates` and fallback diagnostics:

```typescript
interface SelectorMatch {
  selector: ToolSelector;
  toolClass: string;
  tool: string;
  confidence: number;   // cosine similarity, 0–1
}
```
