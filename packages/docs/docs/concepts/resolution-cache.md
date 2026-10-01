---
title: Resolution Cache
sidebar_label: Resolution Cache
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Resolution Cache

The `ResolutionCache` is an LRU cache that stores resolved dispatches — analogous to the inline method cache in `objc_msgSend`. On a cache hit, dispatch skips the embedding and vector search entirely. On a cache miss, the full resolution runs and the result is stored for future calls.

## LRU cache mechanics

The cache maps an intent's `intentKey` (its full text, normalized) to a `ResolvedTool`, tagged with the version context it was resolved under:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
interface ResolvedTool {
  selector: ToolSelector;
  imp: ToolIMP;
  confidence: number;
  resolvedAt: number;          // timestamp
  hitCount: number;
  providerVersion?: string;    // tags checked on every lookup
  modelVersion?: string;
  schemaFingerprint?: string;
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct ResolvedTool {
    var selector: ToolSelector
    var toolClass: String
    var implementation: ToolIMP
    var confidence: Double
    var resolvedAt: TimeInterval  // timestamp
}
```

</TabItem>
</Tabs>

The default cache size is 1024 entries. When the cache is full, the least-recently-used entry is evicted. Configure the size in `RuntimeOptions`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// larger cache for high-traffic deployments
const { runtime } = await loadRuntime('./tools.toolkit.json', { runtimeOptions: { cacheSize: 2048 } });
// or: new ToolRuntime(vectorIndex, embedder, { cacheSize: 2048 })
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let runtime = ToolRuntime(
    vectorIndex: vectorIndex,
    embedder: embedder,
    cacheSize: 2048  // larger cache for high-traffic deployments
)
```

</TabItem>
</Tabs>

## Version tagging

Cache entries are tagged with a `CacheVersionContext` to prevent stale hits after updates:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
interface CacheVersionContext {
  providerVersions: Map<string, string>;    // provider id → version, e.g. "1.2.0"
  modelVersion: string;                     // embedder, e.g. "onnx:all-MiniLM-L6-v2"
  schemaFingerprints: Map<string, string>;  // provider id → hash of its tool schemas
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct CacheVersionContext {
    var providerVersion: String?    // e.g. "1.2.0"
    var modelVersion: String?       // e.g. "gpt-4o"
    var schemaFingerprint: String?  // hash of the compiled artifact
}
```

</TabItem>
</Tabs>

A cache entry is only valid if its version context matches the current runtime context. If any component changes, the entry is treated as a miss.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// Update version context — future dispatches will bypass stale entries
runtime.setProviderVersion('github', '1.2.0');
runtime.setModelVersion('onnx:all-MiniLM-L6-v2');
runtime.updateSchemaFingerprint(githubClass); // recomputed from the class's loaded schemas
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// Update version context — future dispatches will bypass stale entries
runtime.setProviderVersion("1.2.0")
runtime.setModelVersion("gpt-4o")
let fingerprint = computeSchemaFingerprint(newArtifact)
runtime.updateSchemaFingerprint(fingerprint)
```

</TabItem>
</Tabs>

## Schema fingerprint

`computeSchemaFingerprint(schemas)` hashes a list of `{ name, inputSchema }` (sorted by name). `runtime.updateSchemaFingerprint(toolClass)` computes it from a class's loaded schemas; to record one yourself, set it on the cache:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { computeSchemaFingerprint, readArtifact } from '@smallchat/core';

const artifact = await readArtifact('./tools.toolkit.json');
const githubSchemas = Object.values(artifact.tools)
  .filter((tool) => tool.providerId === 'github')
  .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }));

runtime.cache.setSchemaFingerprint('github', computeSchemaFingerprint(githubSchemas));
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let data = try Data(contentsOf: URL(fileURLWithPath: "./tools.json"))
let artifact = try JSONSerialization.jsonObject(with: data)
let fingerprint = computeSchemaFingerprint(artifact)

runtime.updateSchemaFingerprint(fingerprint)
```

</TabItem>
</Tabs>

Recompiling your tool manifests produces a new fingerprint and automatically invalidates the cache.

## Cache invalidation hooks

Register a hook to hear about every invalidation (for example to refresh a UI or an LLM's context); `invalidateOn` returns a function that removes it:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import type { InvalidationHook } from '@smallchat/core';

// event: { type: 'flush' } | { type: 'provider', providerId } | { type: 'selector', selector }
//      | { type: 'stale', reason, key } | { type: 'ui-resource', uri }
const hook: InvalidationHook = (event) => {
  if (event.type === 'provider') console.log(`cache entries for ${event.providerId} dropped`);
};

const stop = runtime.invalidateOn(hook);
// later: stop();
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let hook = InvalidationHook(on: .providerUpdate) { event in
    // return the cache keys to invalidate
    event.affectedProviders.map { "\($0).*" }
}

runtime.invalidateOn(hook)
```

</TabItem>
</Tabs>

Trigger invalidation explicitly:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// Flush all entries for the 'github' provider
runtime.cache.flushProvider('github');

// Flush everything
runtime.cache.flush();
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// Flush all entries for the 'github' provider
runtime.getCache().invalidateByProvider("github")

// Flush everything
runtime.getCache().flush()
```

</TabItem>
</Tabs>

## Hot-reload workflow

The cache makes hot-reload safe. When you recompile your tool definitions:

1. Write the new artifact to disk
2. Load it again with `loadRuntime()` and swap the runtime in, or replace
   individual providers with `runtime.registerClass(cls)` (same name: the
   old class is replaced and every cached resolution is flushed)
3. After changing a provider's tool schemas in place, call
   `runtime.updateSchemaFingerprint(cls)`; entries cached against the old
   fingerprint expire on their next lookup

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// In development — watch for changes and load the new artifact
import { watch } from 'node:fs';
import { loadRuntime } from '@smallchat/core';

let { runtime, upstreams } = await loadRuntime('./tools.json');
watch('./tools.json', async () => {
  const next = await loadRuntime('./tools.json');
  await upstreams.close();
  ({ runtime, upstreams } = next);
  console.log('Runtime reloaded.');
});
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// In development — watch for changes and hot-reload using Swift concurrency
let source = DispatchSource.makeFileSystemObjectSource(
    fileDescriptor: fd,
    eventMask: .write,
    queue: .main
)
source.setEventHandler {
    Task {
        try await runtime.reload("./tools.json")
        print("Runtime reloaded.")
    }
}
source.resume()
```

</TabItem>
</Tabs>

## Direct cache access

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const cache: ResolutionCache = runtime.getCache();

// Inspect a cached entry
const entry = cache.get('search for code');
if (entry) {
  console.log('Cache hit:', entry.toolClass, entry.confidence);
}

// Manually prime the cache
cache.set('search for code', resolvedTool, versionContext);

// Cache statistics
console.log('Hits:', cache.stats.hits);
console.log('Misses:', cache.stats.misses);
console.log('Evictions:', cache.stats.evictions);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let cache = runtime.getCache()

// Inspect a cached entry
if let entry = cache.get("search for code") {
    print("Cache hit:", entry.toolClass, entry.confidence)
}

// Manually prime the cache
cache.set("search for code", resolvedTool, versionContext)

// Cache statistics
print("Hits:", cache.stats.hits)
print("Misses:", cache.stats.misses)
print("Evictions:", cache.stats.evictions)
```

</TabItem>
</Tabs>
