---
title: Method Swizzling
sidebar_label: Method Swizzling
---

# Method Swizzling

Method swizzling replaces a tool implementation at runtime — analogous to
method swizzling in Objective-C. The original implementation is returned, so
the replacement can delegate to it.

This page shows the TypeScript API of `@smallchat/core`.

## `runtime.swizzle(toolClass, selector, newImp)`

```typescript
swizzle(toolClass: ToolClass, selector: ToolSelector, newImp: ToolIMP): ToolIMP | null
```

- `toolClass` — the registered `ToolClass` (provider) to modify
- `selector` — the `ToolSelector` whose implementation is replaced; every
  other selector of that class that dispatched to the same implementation
  (the tool's aliases) is swizzled with it
- `newImp` — the replacement `ToolIMP`
- returns the original `ToolIMP`, or `null` when the selector had none

Find the class, selector and current implementation of a tool by its
canonical id:

```typescript
import { loadRuntime } from '@smallchat/core';
import type { ExecuteOptions, ToolIMP, ToolResult } from '@smallchat/core';

const { runtime } = await loadRuntime('./tools.toolkit.json');

const tool = runtime.getTool('github/search_code')!;   // { id, imp, selectors }
const github = runtime.context.getClasses().find(c => c.name === 'github')!;
const selector = runtime.selectorTable.get(tool.selectors[0])!;

/** The same tool (id, schema, annotations) with another execute(). */
function withExecute(
  imp: ToolIMP,
  execute: (args: Record<string, unknown>, options?: ExecuteOptions) => Promise<ToolResult>,
): ToolIMP {
  return {
    providerId: imp.providerId,
    toolName: imp.toolName,
    transportType: imp.transportType,
    schema: imp.schema,
    schemaLoader: () => imp.schemaLoader(),
    constraints: imp.constraints,
    annotations: imp.annotations,
    execute,
  };
}

const original = runtime.swizzle(github, selector, withExecute(tool.imp, async (args, options) => {
  console.log('[intercepted] github/search_code called with:', args);
  return tool.imp.execute(args, options);
}));
```

The replacement keeps the tool's canonical id, so `dispatchById`, proofs and
decision logs still name `github/search_code`, and arguments are still
validated against its `inputSchema` before `execute` runs.

## Takes effect on the next dispatch

`swizzle()` flushes the whole resolution cache (entries are keyed by intent,
not by selector) and rebuilds the dispatch index, so the next dispatch runs
the new implementation.

## Use cases

### Testing and mocking

Replace live API calls with deterministic fixtures:

```typescript
beforeEach(async () => {
  ({ runtime } = await loadRuntime('./tools.toolkit.json'));
  const tool = runtime.getTool('github/search_code')!;
  const github = runtime.context.getClasses().find(c => c.name === 'github')!;
  runtime.swizzle(github, runtime.selectorTable.get(tool.selectors[0])!, withExecute(tool.imp, async () => ({
    content: fixtures.searchResults,
    metadata: { mocked: true },
  })));
});
```

### Routing and A/B testing

```typescript
let calls = 0;
runtime.swizzle(slack, sendSelector, withExecute(control, async (args, options) =>
  ++calls % 10 === 0 ? experiment.execute(args, options) : control.execute(args, options)));
```

### Hot upgrades

```typescript
const upgraded = await loadNewProviderVersion('github', '2.0.0'); // a ToolIMP
runtime.swizzle(github, createIssueSelector, upgraded);
// Expire resolutions cached against the old provider version
runtime.setProviderVersion('github', '2.0.0');
```

To replace a whole provider, register a new `ToolClass` with the same name
instead: `runtime.registerClass(cls)` replaces the old one and re-indexes.

### Wrapping / decoration

```typescript
runtime.swizzle(github, selector, withExecute(tool.imp, async (args, options) => {
  const start = performance.now();
  try {
    return await tool.imp.execute(args, options);
  } finally {
    metrics.record('github/search_code.latency', performance.now() - start);
  }
}));
```

## Core selectors

Selectors of a class registered with `runtime.registerCoreClass(cls)` are
protected: another class cannot swizzle or shadow them unless the core class
was registered with `{ swizzlable: true }`. The owning class can always
swizzle its own selectors.
