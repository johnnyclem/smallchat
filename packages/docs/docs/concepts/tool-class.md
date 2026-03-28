---
title: ToolClass & ToolProxy
sidebar_label: ToolClass & ToolProxy
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# ToolClass & ToolProxy

`ToolClass` is the provider abstraction — analogous to a class in Objective-C. It groups related tools under a single dispatch table, supports superclass chains for inheritance-based fallback, and declares protocol conformance.

## Provider grouping

Each compiled provider manifest becomes one `ToolClass`. The class holds:

- A **dispatch table** mapping `ToolSelector → ToolIMP`
- An optional **superclass** reference for hierarchical dispatch
- A list of **protocols** the provider conforms to
- A list of **categories** that extend the provider's capabilities

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolClass } from '@smallchat/core';

const githubClass = new ToolClass('github', {
  superclass: baseApiClass,   // optional
  protocols: ['searchable', 'writable'],
});

githubClass.addMethod(selector, async (args) => {
  // implementation
  return { output: '...' };
});
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let githubClass = ToolClass("github", superclass: baseApiClass, protocols: ["searchable", "writable"])
githubClass.addMethod(selector) { args in
    return ToolResult(output: "...")
}
```

</TabItem>
</Tabs>

## Dispatch tables

The dispatch table is a plain `Map<ToolSelector, ToolIMP>`. Lookup is O(1) after the selector is resolved. The table is populated at compile time and loaded from the compiled artifact at runtime.

You can extend a class's dispatch table at runtime:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// Add a new method to an existing class
const runtime = new ToolRuntime({ ... });
await runtime.load('./tools.json');

const cls = runtime.getClass('github');
cls.addMethod(newSelector, newImpl);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// Add a new method to an existing class
let cls = runtime.getClass("github")
cls.addMethod(newSelector, implementation: newImpl)
```

</TabItem>
</Tabs>

## Superclass chains

If a tool is not found in the primary dispatch table, dispatch walks up the superclass chain — exactly as `objc_msgSend` does. This enables provider hierarchies:

```
BaseAPIClass (generic HTTP tools)
  └── GitHubClass (GitHub-specific tools)
        └── GitHubEnterpriseClass (enterprise overrides)
```

When `GitHubEnterpriseClass` does not have a tool for a given selector, dispatch falls back to `GitHubClass`, then to `BaseAPIClass`.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const baseClass = new ToolClass('base-api');
const githubClass = new ToolClass('github', { superclass: baseClass });
const enterpriseClass = new ToolClass('github-enterprise', { superclass: githubClass });
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let base = ToolClass("base-api")
let github = ToolClass("github", superclass: base)
let enterprise = ToolClass("github-enterprise", superclass: github)
```

</TabItem>
</Tabs>

## `ToolProxy` — lazy schema loading

`ToolProxy` is the lazy-loading mechanism — analogous to `NSProxy`. It presents the same interface as `ToolClass` but defers schema loading and embedding until the first dispatch.

Use `ToolProxy` when you have many providers but expect only a subset to be used in any given session. This reduces startup time and memory footprint:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolProxy } from '@smallchat/core';

// Schema is not loaded yet
const lazyGithub = new ToolProxy('github', async () => {
  const manifest = await fetch('/manifests/github.json').then(r => r.json());
  return manifest;
});

// First dispatch triggers schema load and embedding
const result = await runtime.dispatch('search for code', args);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let lazyGithub = ToolProxy("github") {
    let data = try await URLSession.shared.data(from: URL(string: "/manifests/github.json")!)
    return try JSONDecoder().decode(ProviderManifest.self, from: data.0)
}

// First dispatch triggers schema load and embedding
let result = try await runtime.dispatch("search for code", args: args)
```

</TabItem>
</Tabs>

## Protocol conformance

Protocols declare capability interfaces — analogous to Objective-C protocols. A `ToolClass` can declare conformance to a protocol, allowing runtime checks:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import type { ToolProtocol } from '@smallchat/core';

const searchable: ToolProtocol = {
  name: 'searchable',
  requiredSelectors: ['search', 'find', 'lookup'],
};

runtime.registerProtocol(searchable);
runtime.registerClass(githubClass);

// Check at runtime
const cls = runtime.getClass('github');
console.log(cls.conformsToProtocol('searchable')); // true
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let searchable = ToolProtocol(name: "searchable", requiredSelectors: ["search", "find", "lookup"])
runtime.registerProtocol(searchable)

let cls = runtime.getClass("github")
print(cls.conformsToProtocol("searchable")) // true
```

</TabItem>
</Tabs>

## Categories

Categories add methods to a `ToolClass` without subclassing — analogous to Objective-C categories:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import type { ToolCategory } from '@smallchat/core';

const loggingCategory: ToolCategory = {
  targetClass: 'github',
  methods: [
    {
      selector: 'log_api_call',
      implementation: async (args) => {
        console.log('[github]', args);
        return { output: null };
      },
    },
  ],
};

runtime.loadCategory(loggingCategory);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let loggingCategory = ToolCategory(targetClass: "github", methods: [
    ToolCategoryMethod(selector: "log_api_call") { args in
        print("[github]", args)
        return ToolResult(output: nil)
    }
])
runtime.loadCategory(loggingCategory)
```

</TabItem>
</Tabs>

## `canHandle(selector)`

Check whether a `ToolClass` responds to a given selector, including the superclass chain:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const cls = runtime.getClass('github');
const sel = runtime.intern('search for code');
console.log(cls.canHandle(sel)); // true
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let cls = runtime.getClass("github")
let sel = runtime.intern("search for code")
print(cls.canHandle(sel))
```

</TabItem>
</Tabs>

This mirrors `respondsToSelector:` in Objective-C.
