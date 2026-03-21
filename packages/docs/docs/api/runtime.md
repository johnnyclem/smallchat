---
title: ToolRuntime
sidebar_label: ToolRuntime
---

# ToolRuntime API Reference

`ToolRuntime` is the top-level class. It owns the `DispatchContext`, manages the lifecycle of `ToolClass` objects, and provides the public dispatch API.

## Constructor

```typescript
import { ToolRuntime } from '@smallchat/core';
import type { RuntimeOptions } from '@smallchat/core';

const runtime = new ToolRuntime(options: RuntimeOptions);
```

### `RuntimeOptions`

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

## Loading artifacts

### `runtime.load(path)`

Load a compiled artifact from disk:

```typescript
await runtime.load('./tools.json');
```

Parses the artifact, populates the `SelectorTable`, builds `ToolClass` objects, and computes the `schemaFingerprint` for the `ResolutionCache`.

### `runtime.reload(path)`

Hot-reload a compiled artifact without restarting:

```typescript
await runtime.reload('./tools.json');
```

Flushes stale cache entries, replaces the current artifact, and rebuilds the dispatch tables.

## Registration

### `runtime.registerClass(toolClass)`

Register a `ToolClass` directly without loading from an artifact:

```typescript
import { ToolClass } from '@smallchat/core';

const cls = new ToolClass('my-provider');
cls.addMethod(selector, implementation);
runtime.registerClass(cls);
```

### `runtime.registerProtocol(protocol)`

Register a `ToolProtocol` for conformance checks:

```typescript
import type { ToolProtocol } from '@smallchat/core';

const searchable: ToolProtocol = {
  name: 'searchable',
  requiredSelectors: ['search', 'find'],
};
runtime.registerProtocol(searchable);
```

### `runtime.loadCategory(category)`

Extend an existing `ToolClass` with additional methods:

```typescript
import type { ToolCategory } from '@smallchat/core';

const loggingCategory: ToolCategory = {
  targetClass: 'github',
  methods: [{ selector: 'audit_log', implementation: auditImpl }],
};
runtime.loadCategory(loggingCategory);
```

## Dispatch

### `runtime.dispatch(intent, args?)`

Single-shot dispatch. Resolves the intent, invokes the tool, and returns the result:

```typescript
const result = await runtime.dispatch('search for code', {
  query: 'typescript generics',
});
// result: ToolResult { output: ..., metadata: ... }
```

### `runtime.dispatchStream(intent, args?, options?)`

Streaming dispatch. Yields `DispatchEvent` values as execution proceeds:

```typescript
for await (const event of runtime.dispatchStream('summarize document', args)) {
  if (event.type === 'chunk') process.stdout.write(event.content);
}
```

Options:

```typescript
{
  signal?: AbortSignal;  // Cancellation
}
```

### `runtime.inferenceStream(intent, args?, options?)`

Token-level inference stream. Yields `inference-delta` events with individual tokens:

```typescript
for await (const event of runtime.inferenceStream('explain this', args)) {
  if (event.type === 'inference-delta') process.stdout.write(event.token);
}
```

## Method swizzling

### `runtime.swizzle(toolClass, selector, implementation)`

Replace a tool implementation at runtime:

```typescript
const sel = runtime.intern('search for code');
const original = runtime.getImplementation('github', sel);

runtime.swizzle('github', sel, async (args) => {
  console.log('intercepted');
  return original?.(args) ?? { output: null };
});
```

### `runtime.getImplementation(toolClass, selector)`

Retrieve the current implementation for a class + selector:

```typescript
const impl = runtime.getImplementation('github', sel);
```

Returns `null` if not registered.

## Selector interning

### `runtime.intern(intent)`

Register or retrieve the canonical selector for an intent string:

```typescript
const sel = runtime.intern('search for code');
// → 'sel_search_code' (or the canonical selector ID)
```

## Header generation

### `runtime.generateHeader()`

Generate a TypeScript declaration file from the loaded artifact — analogous to `objc/runtime.h`:

```typescript
const header = runtime.generateHeader();
fs.writeFileSync('./tools.d.ts', header);
```

The generated header contains typed function signatures for each registered tool.

## Version management

### `runtime.setProviderVersion(version)`

Update the provider version tag. Invalidates cache entries with a different provider version:

```typescript
runtime.setProviderVersion('1.2.0');
```

### `runtime.setModelVersion(version)`

Update the model version tag:

```typescript
runtime.setModelVersion('gpt-4o');
```

### `runtime.updateSchemaFingerprint(fingerprint)`

Update the schema fingerprint. Usually called automatically by `load()` / `reload()`:

```typescript
const fingerprint = computeSchemaFingerprint(artifact);
runtime.updateSchemaFingerprint(fingerprint);
```

### `runtime.invalidateOn(hook)`

Register an invalidation hook:

```typescript
import type { InvalidationHook } from '@smallchat/core';

runtime.invalidateOn({
  on: 'provider-update',
  flush: (event) => event.affectedProviders.map(p => `${p}.*`),
});
```

## Accessors

### `runtime.getClass(id)`

Return the `ToolClass` registered under the given ID, or `null`:

```typescript
const cls = runtime.getClass('github');
```

### `runtime.getCache()`

Return the `ResolutionCache` for direct inspection or manipulation:

```typescript
const cache = runtime.getCache();
console.log(cache.stats);
```
