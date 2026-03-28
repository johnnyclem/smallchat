---
title: Streaming
sidebar_label: Streaming
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

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

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

for try await event in runtime.dispatchStream("summarize this document", args: ["url": "..."]) {
    switch event {
    case .resolving(let intent):
        print("Resolving: \(intent)")
    case .toolStart(let tool, let provider, _, _):
        print("Invoking: \(tool) on \(provider)")
    case .chunk(let content, _):
        print(content, terminator: "")
    case .done:
        print("\nDone.")
    case .error(let message, _):
        print("Error: \(message)")
    default:
        break
    }
}
```

</TabItem>
</Tabs>

## `inferenceStream()`

Tier 1 — individual token deltas from the LLM provider, as they arrive:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
for try await token in runtime.inferenceStream("explain this code", args: ["code": source]) {
    print(token, terminator: "")
}
print("\n[stream complete]")
```

</TabItem>
</Tabs>

## Event sequence

Every streaming dispatch produces events in this strict order:

```
resolving  →  tool-start  →  (chunk* | inference-delta*)  →  done
```

An `error` event may appear at any point. After an `error` event, no further events are emitted.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// DispatchEvent enum
enum DispatchEvent {
    case resolving(intent: String)
    case toolStart(tool: String, provider: String, confidence: Double, metadata: [String: Any])
    case chunk(content: String, metadata: [String: Any])
    case inferenceDelta(delta: String, metadata: [String: Any])
    case done(result: ToolResult?)
    case error(message: String, cause: Error?)
}
```

</TabItem>
</Tabs>

## Cancellation

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

Use Swift structured concurrency and Task cancellation:

```swift
let task = Task {
    for try await event in runtime.dispatchStream("long running task", args: args) {
        if case .chunk(let content, _) = event { print(content, terminator: "") }
    }
}

// Cancel after 5 seconds
Task {
    try await Task.sleep(for: .seconds(5))
    task.cancel()
}
```

</TabItem>
</Tabs>

Backpressure is handled automatically by the async generator protocol — the generator pauses if the consumer is slow.

## Nested streaming

Compose streaming dispatches naturally:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

Using standard async generator delegation:

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

</TabItem>
<TabItem value="swift" label="Swift">

Using `AsyncThrowingStream`:

```swift
func streamWithContext(_ intent: String) -> AsyncThrowingStream<DispatchEvent, Error> {
    AsyncThrowingStream { continuation in
        Task {
            let prefs = try await runtime.dispatch("get user preferences")
            for try await event in runtime.dispatchStream(intent, args: ["preferences": prefs.output]) {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }
}

// Use it exactly like any other stream
for try await event in streamWithContext("summarize recent issues") {
    if case .chunk(let content, _) = event { print(content, terminator: "") }
}
```

</TabItem>
</Tabs>

## UI integration

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

Use a React state variable and update it from the stream:

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

</TabItem>
<TabItem value="swift" label="Swift">

Use a SwiftUI `ObservableObject` and update published properties from the stream:

```swift
@MainActor
class DispatchViewModel: ObservableObject {
    @Published var output = ""
    @Published var isLoading = false

    func dispatch(_ intent: String) async throws {
        output = ""
        isLoading = true
        for try await event in runtime.dispatchStream(intent, args: args) {
            if case .chunk(let content, _) = event { output += content }
            if case .done = event { isLoading = false }
        }
    }
}
```

</TabItem>
</Tabs>

## Why no middleware

Most frameworks require you to configure callback managers, output parsers, or streaming adapters before tokens reach your UI. smallchat has none of that. The generator yields raw events from the provider. You decide what to do with them.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// smallchat
for try await event in runtime.dispatchStream(intent, args: args) {
    if case .chunk(let content, _) = event { print(content, terminator: "") }
}
```

</TabItem>
</Tabs>
