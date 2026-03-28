---
title: ToolRuntime
sidebar_label: ToolRuntime
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# ToolRuntime API Reference

`ToolRuntime` is the top-level class. It owns the `DispatchContext`, manages the lifecycle of `ToolClass` objects, and provides the public dispatch API.

## Constructor

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolRuntime } from '@smallchat/core';
import type { RuntimeOptions } from '@smallchat/core';

const runtime = new ToolRuntime(options: RuntimeOptions);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let runtime = ToolRuntime(
    vectorIndex: MemoryVectorIndex(),
    embedder: LocalEmbedder()
)
```

</TabItem>
</Tabs>

### `RuntimeOptions`

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
interface RuntimeOptions {
  embedder: Embedder;           // Required — embedding provider
  vectorIndex: VectorIndex;     // Required — vector similarity index

  selectorThreshold?: number;   // Default: 0.95 — deduplication threshold
  cacheSize?: number;           // Default: 1024 — LRU cache size
  minConfidence?: number;       // Default: 0.85 — minimum match confidence
  modelVersion?: string;        // Optional — version tag for cache keys
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// In Swift, RuntimeOptions is not a separate type.
// Parameters are passed directly to the ToolRuntime initializer:
let runtime = ToolRuntime(
    vectorIndex: MemoryVectorIndex(),
    embedder: LocalEmbedder(),
    selectorThreshold: 0.95,   // Default: 0.95 — deduplication threshold
    cacheSize: 1024,           // Default: 1024 — LRU cache size
    minConfidence: 0.85,       // Default: 0.85 — minimum match confidence
    modelVersion: "gpt-4o"     // Optional — version tag for cache keys
)
```

</TabItem>
</Tabs>

## Loading artifacts

### `runtime.load(path)`

Load a compiled artifact from disk:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
await runtime.load('./tools.json');
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
try await runtime.load("./tools.json")
```

</TabItem>
</Tabs>

Parses the artifact, populates the `SelectorTable`, builds `ToolClass` objects, and computes the `schemaFingerprint` for the `ResolutionCache`.

### `runtime.reload(path)`

Hot-reload a compiled artifact without restarting:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
await runtime.reload('./tools.json');
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
try await runtime.reload("./tools.json")
```

</TabItem>
</Tabs>

Flushes stale cache entries, replaces the current artifact, and rebuilds the dispatch tables.

## Registration

### `runtime.registerClass(toolClass)`

Register a `ToolClass` directly without loading from an artifact:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolClass } from '@smallchat/core';

const cls = new ToolClass('my-provider');
cls.addMethod(selector, implementation);
runtime.registerClass(cls);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let cls = ToolClass("my-provider", superclass: nil, protocols: [])
cls.addMethod(selector, implementation: { args in
    // ...
})
runtime.registerClass(cls)
```

</TabItem>
</Tabs>

### `runtime.registerProtocol(protocol)`

Register a `ToolProtocol` for conformance checks:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import type { ToolProtocol } from '@smallchat/core';

const searchable: ToolProtocol = {
  name: 'searchable',
  requiredSelectors: ['search', 'find'],
};
runtime.registerProtocol(searchable);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let searchable = ToolProtocol(name: "searchable", requiredSelectors: ["search", "find"])
runtime.registerProtocol(searchable)
```

</TabItem>
</Tabs>

### `runtime.loadCategory(category)`

Extend an existing `ToolClass` with additional methods:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import type { ToolCategory } from '@smallchat/core';

const loggingCategory: ToolCategory = {
  targetClass: 'github',
  methods: [{ selector: 'audit_log', implementation: auditImpl }],
};
runtime.loadCategory(loggingCategory);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let loggingCategory = ToolCategory(
    targetClass: "github",
    methods: [/* ... */]
)
runtime.loadCategory(loggingCategory)
```

</TabItem>
</Tabs>

## Dispatch

### `runtime.dispatch(intent, args?)`

Single-shot dispatch. Resolves the intent, invokes the tool, and returns the result:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const result = await runtime.dispatch('search for code', {
  query: 'typescript generics',
});
// result: ToolResult { output: ..., metadata: ... }
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let result = try await runtime.dispatch("search for code", args: [
    "query": "typescript generics"
])
// result: ToolResult { output: ..., metadata: ... }
```

</TabItem>
</Tabs>

### `runtime.dispatchStream(intent, args?, options?)`

Streaming dispatch. Yields `DispatchEvent` values as execution proceeds:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
for await (const event of runtime.dispatchStream('summarize document', args)) {
  if (event.type === 'chunk') process.stdout.write(event.content);
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
for try await event in runtime.dispatchStream("summarize document", args: args) {
    switch event {
    case .chunk(let content, _):
        print(content, terminator: "")
    case .done(let result):
        break
    }
}
```

</TabItem>
</Tabs>

Options:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
{
  signal?: AbortSignal;  // Cancellation
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// In Swift, use Task cancellation instead of AbortSignal:
let task = Task {
    for try await event in runtime.dispatchStream("summarize document", args: args) {
        // ...
    }
}
// Cancel with:
task.cancel()
```

</TabItem>
</Tabs>

### `runtime.inferenceStream(intent, args?, options?)`

Token-level inference stream. Yields `inference-delta` events with individual tokens:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
for await (const event of runtime.inferenceStream('explain this', args)) {
  if (event.type === 'inference-delta') process.stdout.write(event.token);
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
for try await token in runtime.inferenceStream("explain this", args: args) {
    print(token, terminator: "")
}
```

</TabItem>
</Tabs>

## Method swizzling

### `runtime.swizzle(toolClass, selector, implementation)`

Replace a tool implementation at runtime:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const sel = runtime.intern('search for code');
const original = runtime.getImplementation('github', sel);

runtime.swizzle('github', sel, async (args) => {
  console.log('intercepted');
  return original?.(args) ?? { output: null };
});
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let sel = runtime.intern("search for code")
let original = runtime.getImplementation("github", sel)

runtime.swizzle("github", sel) { args in
    print("intercepted")
    return original?(args) ?? ToolResult(output: nil)
}
```

</TabItem>
</Tabs>

### `runtime.getImplementation(toolClass, selector)`

Retrieve the current implementation for a class + selector:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const impl = runtime.getImplementation('github', sel);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let impl = runtime.getImplementation("github", sel)
```

</TabItem>
</Tabs>

Returns `null` if not registered.

## Selector interning

### `runtime.intern(intent)`

Register or retrieve the canonical selector for an intent string:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const sel = runtime.intern('search for code');
// → 'sel_search_code' (or the canonical selector ID)
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let sel = runtime.intern("search for code")
// → "sel_search_code" (or the canonical selector ID)
```

</TabItem>
</Tabs>

## Header generation

### `runtime.generateHeader()`

Generate a TypeScript declaration file from the loaded artifact — analogous to `objc/runtime.h`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const header = runtime.generateHeader();
fs.writeFileSync('./tools.d.ts', header);
```

</TabItem>
</Tabs>

The generated header contains typed function signatures for each registered tool.

## Version management

### `runtime.setProviderVersion(version)`

Update the provider version tag. Invalidates cache entries with a different provider version:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
runtime.setProviderVersion('1.2.0');
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
runtime.setProviderVersion("1.2.0")
```

</TabItem>
</Tabs>

### `runtime.setModelVersion(version)`

Update the model version tag:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
runtime.setModelVersion('gpt-4o');
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
runtime.setModelVersion("gpt-4o")
```

</TabItem>
</Tabs>

### `runtime.updateSchemaFingerprint(fingerprint)`

Update the schema fingerprint. Usually called automatically by `load()` / `reload()`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const fingerprint = computeSchemaFingerprint(artifact);
runtime.updateSchemaFingerprint(fingerprint);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let fingerprint = computeSchemaFingerprint(artifact)
runtime.updateSchemaFingerprint(fingerprint)
```

</TabItem>
</Tabs>

### `runtime.invalidateOn(hook)`

Register an invalidation hook:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import type { InvalidationHook } from '@smallchat/core';

runtime.invalidateOn({
  on: 'provider-update',
  flush: (event) => event.affectedProviders.map(p => `${p}.*`),
});
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

runtime.invalidateOn(InvalidationHook(on: .providerUpdate) { event in
    event.affectedProviders.map { "\($0).*" }
})
```

</TabItem>
</Tabs>

## Accessors

### `runtime.getClass(id)`

Return the `ToolClass` registered under the given ID, or `null`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const cls = runtime.getClass('github');
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let cls = runtime.getClass("github")
```

</TabItem>
</Tabs>

### `runtime.getCache()`

Return the `ResolutionCache` for direct inspection or manipulation:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const cache = runtime.getCache();
console.log(cache.stats);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let cache = runtime.getCache()
print(cache.stats)
```

</TabItem>
</Tabs>
