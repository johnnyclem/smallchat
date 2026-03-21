---
title: Method Swizzling
sidebar_label: Method Swizzling
---

# Method Swizzling

Method swizzling replaces a tool implementation at runtime — analogous to method swizzling in Objective-C. The original implementation can be preserved and optionally called from the replacement.

## `runtime.swizzle()`

```typescript
runtime.swizzle(toolClass, selector, newImplementation);
```

Parameters:

- `toolClass` — string identifier of the `ToolClass` to modify
- `selector` — `ToolSelector` identifying the method to replace
- `newImplementation` — `ToolIMP` that replaces the original

```typescript
import { ToolRuntime } from '@smallchat/core';

const runtime = new ToolRuntime({ ... });
await runtime.load('./tools.json');

// Get the selector for the intent we want to intercept
const sel = runtime.intern('search for code');

// Replace the implementation
runtime.swizzle('github', sel, async (args) => {
  console.log('[intercepted] github.search_code called with:', args);
  return { output: 'mocked result for tests' };
});
```

## Cache flush on swizzle

Every call to `swizzle()` automatically flushes cache entries that reference the affected selector. This ensures subsequent dispatches pick up the new implementation rather than the stale cached one.

```typescript
// Before swizzle: cache may contain resolved entries for 'search for code'
runtime.swizzle('github', sel, newImpl);
// After swizzle: those entries are purged; next dispatch resolves fresh
```

## Use cases

### Testing and mocking

Swizzle in test setup to replace live API calls with deterministic fixtures:

```typescript
beforeEach(async () => {
  await runtime.load('./tools.json');

  const sel = runtime.intern('search for code');
  runtime.swizzle('github', sel, async (args) => ({
    output: fixtures.searchResults,
    metadata: { mocked: true },
  }));
});
```

### Routing and A/B testing

Redirect traffic between implementations without changing dispatch configuration:

```typescript
const sel = runtime.intern('send message');
const control = runtime.getImplementation('slack', sel);
const experiment = newSlackClientImpl;

let experimentTraffic = 0;
runtime.swizzle('slack', sel, async (args) => {
  if (++experimentTraffic % 10 === 0) {
    return experiment(args);  // 10% of calls go to experiment
  }
  return control(args);
});
```

### Hot upgrades

Upgrade a tool implementation without restarting or recompiling:

```typescript
// Load a new version of a provider at runtime
const newImpl = await loadNewProviderVersion('github', '2.0.0');

const sel = runtime.intern('create issue');
runtime.swizzle('github', sel, newImpl);

// Update the provider version so the cache invalidates
runtime.setProviderVersion('2.0.0');
```

### Wrapping / decoration

Call the original implementation and add pre/post processing:

```typescript
const sel = runtime.intern('search for code');
const original = runtime.getImplementation('github', sel);

runtime.swizzle('github', sel, async (args) => {
  const start = Date.now();
  const result = await original(args);
  const elapsed = Date.now() - start;

  metrics.record('github.search_code.latency', elapsed);
  return result;
});
```

## `getImplementation()`

Retrieve the current implementation for a class/selector before swizzling (to preserve it for delegation):

```typescript
const original = runtime.getImplementation('github', sel);
```

Returns `null` if no implementation is registered for that selector in the given class.
