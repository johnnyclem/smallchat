---
title: Streaming
sidebar_label: Streaming
---

# Streaming

smallchat opens the actual provider stream. Dispatch resolves the intent once, then hands control straight to the LLM provider. Tokens arrive the moment they are generated. No waiting for the full result.

## The three tiers

| Tier | Method | Granularity | Use case |
|------|--------|-------------|----------|
| 1 | `inferenceStream` | Token-level deltas | Streaming LLM inference directly to the UI |
| 2 | `dispatchStream` | Chunk-level results | Tool results streamed in logical chunks |
| 3 | `dispatch` | Completed result | Synchronous-style, wait for full output |

All three tiers share the same dispatch resolution path. The difference is only in how execution is performed and how results are delivered.

## `dispatchStream()`

```typescript
import { ToolRuntime } from '@smallchat/core';

const runtime = new ToolRuntime({ ... });
await runtime.load('./tools.json');

for await (const event of runtime.dispatchStream('summarize this document', { url: '...' })) {
  switch (event.type) {
    case 'resolving':
      console.log('Resolving:', event.intent);
      break;
    case 'tool-start':
      console.log('Invoking:', event.tool, 'on', event.provider);
      break;
    case 'chunk':
      process.stdout.write(event.content);
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

## `inferenceStream()`

Tier 1 — individual token deltas from the LLM provider, as they arrive:

```typescript
for await (const event of runtime.inferenceStream('explain this code', { code: source })) {
  if (event.type === 'inference-delta') {
    process.stdout.write(event.token);
  }
  if (event.type === 'done') {
    console.log('\n[stream complete]');
  }
}
```

## Event sequence

Every streaming dispatch produces events in this strict order:

```
resolving  →  tool-start  →  (chunk* | inference-delta*)  →  done
```

An `error` event may appear at any point. After an `error` event, no further events are emitted.

```typescript
// DispatchEvent union type
type DispatchEvent =
  | DispatchEventResolving       // { type: 'resolving', intent: string }
  | DispatchEventToolStart       // { type: 'tool-start', tool: string, provider: string }
  | DispatchEventChunk           // { type: 'chunk', content: string }
  | DispatchEventInferenceDelta  // { type: 'inference-delta', token: string }
  | DispatchEventDone            // { type: 'done', result?: ToolResult }
  | DispatchEventError           // { type: 'error', message: string, cause?: unknown }
```

## Cancellation via AbortController

Standard `AbortController` / `AbortSignal` works exactly as expected. Pass the signal through the dispatch options:

```typescript
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

try {
  for await (const event of runtime.dispatchStream('long running task', args, {
    signal: controller.signal,
  })) {
    if (event.type === 'chunk') process.stdout.write(event.content);
  }
} catch (e) {
  if (e.name === 'AbortError') {
    console.log('Stream cancelled.');
  }
}
```

Backpressure is handled automatically by the async generator protocol — the generator pauses if the consumer is slow.

## Nested streaming

Compose streaming dispatches naturally using standard async generator delegation:

```typescript
async function* streamWithContext(intent: string) {
  // First, dispatch a single-shot call to get context
  const prefs = await runtime.dispatch('get user preferences');

  // Then delegate to a streaming dispatch enriched with that context
  yield* runtime.dispatchStream(intent, {
    preferences: prefs.output,
  });
}

// Use it exactly like any other stream
for await (const event of streamWithContext('summarize recent issues')) {
  if (event.type === 'chunk') process.stdout.write(event.content);
}
```

The `yield*` delegation is zero-overhead — no intermediate buffering.

## React integration

Use a state variable and update it from the stream:

```typescript
async function handleDispatch(intent: string) {
  setOutput('');
  setLoading(true);

  for await (const event of runtime.dispatchStream(intent, args)) {
    if (event.type === 'chunk') {
      setOutput(prev => prev + event.content);
    }
    if (event.type === 'done') {
      setLoading(false);
    }
  }
}
```

## Why no middleware

Most frameworks require you to configure callback managers, output parsers, or streaming adapters before tokens reach your UI. smallchat has none of that. The generator yields raw events from the provider. You decide what to do with them.

```typescript
// LangChain (simplified)
chain.call({ input }, {
  callbacks: [new StreamingStdOutCallbackHandler()],
});

// smallchat
for await (const event of runtime.dispatchStream(intent, args)) {
  if (event.type === 'chunk') process.stdout.write(event.content);
}
```
