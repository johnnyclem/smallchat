---
title: Resolution Cache
sidebar_label: Resolution Cache
---

# Resolution Cache

The `ResolutionCache` is an LRU cache that stores resolved dispatches — analogous to the inline method cache in `objc_msgSend`. On a cache hit, dispatch skips the embedding and vector search entirely. On a cache miss, the full resolution runs and the result is stored for future calls.

## LRU cache mechanics

The cache maps a **cache key** (intent string + version context) to a `ResolvedTool`:

```typescript
interface ResolvedTool {
  selector: ToolSelector;
  toolClass: string;
  implementation: ToolIMP;
  confidence: number;
  resolvedAt: number;  // timestamp
}
```

The default cache size is 1024 entries. When the cache is full, the least-recently-used entry is evicted. Configure the size in `RuntimeOptions`:

```typescript
const runtime = new ToolRuntime({
  cacheSize: 2048,  // larger cache for high-traffic deployments
  embedder,
  vectorIndex,
});
```

## Version tagging

Cache entries are tagged with a `CacheVersionContext` to prevent stale hits after updates:

```typescript
interface CacheVersionContext {
  providerVersion?: string;    // e.g. "1.2.0"
  modelVersion?: string;       // e.g. "gpt-4o"
  schemaFingerprint?: string;  // hash of the compiled artifact
}
```

A cache entry is only valid if its version context matches the current runtime context. If any component changes, the entry is treated as a miss.

```typescript
// Update version context — future dispatches will bypass stale entries
runtime.setProviderVersion('1.2.0');
runtime.setModelVersion('gpt-4o');
runtime.updateSchemaFingerprint(newArtifact);
```

## Schema fingerprint

The `computeSchemaFingerprint()` helper generates a hash of a compiled artifact, suitable for use as the `schemaFingerprint` in `CacheVersionContext`:

```typescript
import { computeSchemaFingerprint } from '@smallchat/core';

const artifact = JSON.parse(fs.readFileSync('./tools.json', 'utf8'));
const fingerprint = computeSchemaFingerprint(artifact);

runtime.updateSchemaFingerprint(fingerprint);
```

Recompiling your tool manifests produces a new fingerprint and automatically invalidates the cache.

## Cache invalidation hooks

Register invalidation hooks to flush specific cache entries when external state changes:

```typescript
import type { InvalidationHook, InvalidationEvent } from '@smallchat/core';

const hook: InvalidationHook = {
  on: 'provider-update',
  flush: (event: InvalidationEvent) => {
    // return the cache keys to invalidate
    return event.affectedProviders.map(p => `github.*`);
  },
};

runtime.invalidateOn(hook);
```

Trigger invalidation explicitly:

```typescript
// Flush all entries for the 'github' provider
runtime.getCache().invalidateByProvider('github');

// Flush everything
runtime.getCache().flush();
```

## Hot-reload workflow

The cache makes hot-reload safe. When you recompile your tool definitions:

1. Write the new artifact to disk
2. Call `runtime.reload('./tools.json')` — reloads and computes a new fingerprint
3. The cache detects the changed fingerprint and invalidates stale entries
4. Subsequent dispatches rebuild the cache from the new artifact

```typescript
// In development — watch for changes and hot-reload
import { watch } from 'fs';

watch('./tools.json', async () => {
  await runtime.reload('./tools.json');
  console.log('Runtime reloaded.');
});
```

## Direct cache access

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
