---
title: Method Swizzling
sidebar_label: Method Swizzling
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Method Swizzling

Method swizzling replaces a tool implementation at runtime — analogous to method swizzling in Objective-C. The original implementation can be preserved and optionally called from the replacement.

## `runtime.swizzle()`

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
runtime.swizzle(toolClass, selector, newImplementation);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
runtime.swizzle(toolClass, selector, implementation: newImplementation)
```

</TabItem>
</Tabs>

Parameters:

- `toolClass` — string identifier of the `ToolClass` to modify
- `selector` — `ToolSelector` identifying the method to replace
- `newImplementation` — `ToolIMP` that replaces the original

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let sel = runtime.intern("search for code")
runtime.swizzle("github", sel) { args in
    print("[intercepted] github.search_code called with:", args)
    return ToolResult(output: "mocked result for tests")
}
```

</TabItem>
</Tabs>

## Cache flush on swizzle

Every call to `swizzle()` automatically flushes cache entries that reference the affected selector. This ensures subsequent dispatches pick up the new implementation rather than the stale cached one.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// Before swizzle: cache may contain resolved entries for 'search for code'
runtime.swizzle('github', sel, newImpl);
// After swizzle: those entries are purged; next dispatch resolves fresh
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// Before swizzle: cache may contain resolved entries for "search for code"
runtime.swizzle("github", sel, implementation: newImpl)
// After swizzle: those entries are purged; next dispatch resolves fresh
```

</TabItem>
</Tabs>

## Use cases

### Testing and mocking

Swizzle in test setup to replace live API calls with deterministic fixtures:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
func setUp() async throws {
    try await runtime.load("./tools.json")
    let sel = runtime.intern("search for code")
    runtime.swizzle("github", sel) { args in
        ToolResult(output: fixtures.searchResults, metadata: ["mocked": true])
    }
}
```

</TabItem>
</Tabs>

### Routing and A/B testing

Redirect traffic between implementations without changing dispatch configuration:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let sel = runtime.intern("send message")
let control = runtime.getImplementation("slack", sel)
var experimentTraffic = 0
runtime.swizzle("slack", sel) { args in
    experimentTraffic += 1
    if experimentTraffic % 10 == 0 {
        return try await experiment(args)
    }
    return try await control?(args) ?? ToolResult(output: nil)
}
```

</TabItem>
</Tabs>

### Hot upgrades

Upgrade a tool implementation without restarting or recompiling:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// Load a new version of a provider at runtime
const newImpl = await loadNewProviderVersion('github', '2.0.0');

const sel = runtime.intern('create issue');
runtime.swizzle('github', sel, newImpl);

// Update the provider version so the cache invalidates
runtime.setProviderVersion('2.0.0');
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let newImpl = try await loadNewProviderVersion("github", version: "2.0.0")
let sel = runtime.intern("create issue")
runtime.swizzle("github", sel, implementation: newImpl)
runtime.setProviderVersion("2.0.0")
```

</TabItem>
</Tabs>

### Wrapping / decoration

Call the original implementation and add pre/post processing:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let sel = runtime.intern("search for code")
let original = runtime.getImplementation("github", sel)
runtime.swizzle("github", sel) { args in
    let start = ContinuousClock.now
    let result = try await original?(args) ?? ToolResult(output: nil)
    let elapsed = ContinuousClock.now - start
    metrics.record("github.search_code.latency", value: elapsed)
    return result
}
```

</TabItem>
</Tabs>

## `getImplementation()`

Retrieve the current implementation for a class/selector before swizzling (to preserve it for delegation):

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const original = runtime.getImplementation('github', sel);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let original = runtime.getImplementation("github", sel)
```

</TabItem>
</Tabs>

Returns `null` if no implementation is registered for that selector in the given class.
