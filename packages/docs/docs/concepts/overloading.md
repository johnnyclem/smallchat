---
title: Function Overloading
sidebar_label: Function Overloading
---

# Function Overloading

A single `ToolSelector` can map to multiple implementations with different parameter signatures. The `OverloadTable` resolves which implementation to call based on argument types and arity — analogous to method overloading in statically-typed languages, but resolved at runtime.

## Multiple signatures per selector

When multiple tools from different providers share a selector (e.g. both `github.search_code` and `gitlab.search_code` resolve to the "search code" selector), the `OverloadTable` holds both implementations:

```typescript
import { OverloadTable } from '@smallchat/core';

const table = new OverloadTable();

table.register(selector, {
  signature: {
    parameters: [
      { name: 'query', type: SCType.String },
      { name: 'repo', type: SCType.String },
    ],
    returnType: SCType.Array,
  },
  implementation: githubSearchImpl,
});

table.register(selector, {
  signature: {
    parameters: [
      { name: 'query', type: SCType.String },
      { name: 'projectId', type: SCType.Number },
    ],
    returnType: SCType.Array,
  },
  implementation: gitlabSearchImpl,
});
```

## Resolution priority

When multiple signatures match, resolution applies these priorities in order:

1. **Exact type match** — every argument type exactly matches the declared parameter type
2. **Superclass match** — argument types are subclasses of declared parameter types (using `isSubclass`)
3. **Union match** — argument types intersect a declared union type
4. **Any match** — the signature accepts `any` for that parameter position

Within the same priority tier, arity (number of arguments) acts as a tiebreaker — more specific (higher arity) signatures win.

```typescript
// Given two signatures:
// A: (query: string, repo: string)
// B: (query: string)

// Call with (query: "foo", repo: "bar/baz")
// → A wins: exact match with 2 args vs 1 arg
```

## `OverloadAmbiguityError`

If two signatures score identically and neither is more specific, an `OverloadAmbiguityError` is thrown:

```typescript
import { OverloadAmbiguityError } from '@smallchat/core';

try {
  await runtime.dispatch('search for code', args);
} catch (e) {
  if (e instanceof OverloadAmbiguityError) {
    // e.candidates — the ambiguous implementations
    console.error('Ambiguous overload:', e.candidates);
  }
}
```

Resolve ambiguity by making signatures more specific, or by adding a discriminating parameter.

## Semantic overloads (compiler-generated)

The compiler can automatically generate semantic overload groups. When two tools have description similarity above `overloadThreshold`, the compiler groups them under one selector and creates overload entries for each:

```typescript
import { ToolCompiler } from '@smallchat/core';

const compiler = new ToolCompiler(embedder, vectorIndex);
const result = await compiler.compile(manifests, {
  overloadThreshold: 0.88,  // group tools with similarity >= 0.88
});

// result.overloadGroups lists all auto-generated groups
```

This is "Phase 2.5" of the compile pipeline — optional but useful for large provider sets where tools naturally cluster by semantic domain.

## Arity tiebreaker

When type scores are equal, arity comparison prefers:

- **Higher arity** wins over lower arity (more specific)
- **Required-only arity** is compared first; optional parameters are counted separately

```typescript
// A: (query: string, language: string, repo: string)  — arity 3
// B: (query: string, language: string)                — arity 2
// C: (query: string)                                  — arity 1

// All arguments provided → A wins
// Only query + language → B wins
// Only query → C wins
```

## `OverloadEntry` and `OverloadResolutionResult`

```typescript
export interface OverloadEntry {
  selector: ToolSelector;
  signature: SCMethodSignature;
  implementation: ToolIMP;
  priority?: number;  // explicit priority override
}

export interface OverloadResolutionResult {
  entry: OverloadEntry;
  matchQuality: MatchQuality;  // 'exact' | 'superclass' | 'union' | 'any'
  score: number;               // 0–1
}
```
