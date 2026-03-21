---
title: ToolClass & ToolProxy
sidebar_label: ToolClass & ToolProxy
---

# ToolClass & ToolProxy

`ToolClass` is the provider abstraction — analogous to a class in Objective-C. It groups related tools under a single dispatch table, supports superclass chains for inheritance-based fallback, and declares protocol conformance.

## Provider grouping

Each compiled provider manifest becomes one `ToolClass`. The class holds:

- A **dispatch table** mapping `ToolSelector → ToolIMP`
- An optional **superclass** reference for hierarchical dispatch
- A list of **protocols** the provider conforms to
- A list of **categories** that extend the provider's capabilities

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

## Dispatch tables

The dispatch table is a plain `Map<ToolSelector, ToolIMP>`. Lookup is O(1) after the selector is resolved. The table is populated at compile time and loaded from the compiled artifact at runtime.

You can extend a class's dispatch table at runtime:

```typescript
// Add a new method to an existing class
const runtime = new ToolRuntime({ ... });
await runtime.load('./tools.json');

const cls = runtime.getClass('github');
cls.addMethod(newSelector, newImpl);
```

## Superclass chains

If a tool is not found in the primary dispatch table, dispatch walks up the superclass chain — exactly as `objc_msgSend` does. This enables provider hierarchies:

```
BaseAPIClass (generic HTTP tools)
  └── GitHubClass (GitHub-specific tools)
        └── GitHubEnterpriseClass (enterprise overrides)
```

When `GitHubEnterpriseClass` does not have a tool for a given selector, dispatch falls back to `GitHubClass`, then to `BaseAPIClass`.

```typescript
const baseClass = new ToolClass('base-api');
const githubClass = new ToolClass('github', { superclass: baseClass });
const enterpriseClass = new ToolClass('github-enterprise', { superclass: githubClass });
```

## `ToolProxy` — lazy schema loading

`ToolProxy` is the lazy-loading mechanism — analogous to `NSProxy`. It presents the same interface as `ToolClass` but defers schema loading and embedding until the first dispatch.

Use `ToolProxy` when you have many providers but expect only a subset to be used in any given session. This reduces startup time and memory footprint:

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

## Protocol conformance

Protocols declare capability interfaces — analogous to Objective-C protocols. A `ToolClass` can declare conformance to a protocol, allowing runtime checks:

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

## Categories

Categories add methods to a `ToolClass` without subclassing — analogous to Objective-C categories:

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

## `canHandle(selector)`

Check whether a `ToolClass` responds to a given selector, including the superclass chain:

```typescript
const cls = runtime.getClass('github');
const sel = runtime.intern('search for code');
console.log(cls.canHandle(sel)); // true
```

This mirrors `respondsToSelector:` in Objective-C.
