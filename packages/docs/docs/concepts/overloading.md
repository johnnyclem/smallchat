---
title: Function Overloading
sidebar_label: Function Overloading
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Function Overloading

A single `ToolSelector` can map to multiple implementations with different parameter signatures. The `OverloadTable` resolves which implementation to call based on argument types and arity — analogous to method overloading in statically-typed languages, but resolved at runtime.

## Multiple signatures per selector

When multiple tools from different providers share a selector (e.g. both `github.search_code` and `gitlab.search_code` resolve to the "search code" selector), the `OverloadTable` holds both implementations:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let table = OverloadTable()

table.register(selector, entry: OverloadEntry(
    signature: SCMethodSignature(
        parameters: [
            SCParameter(name: "query", type: .string),
            SCParameter(name: "repo", type: .string),
        ],
        returnType: .array
    ),
    implementation: githubSearchImpl
))

table.register(selector, entry: OverloadEntry(
    signature: SCMethodSignature(
        parameters: [
            SCParameter(name: "query", type: .string),
            SCParameter(name: "projectId", type: .number),
        ],
        returnType: .array
    ),
    implementation: gitlabSearchImpl
))
```

</TabItem>
</Tabs>

## Resolution priority

When multiple signatures match, resolution applies these priorities in order:

1. **Exact type match** — every argument type exactly matches the declared parameter type
2. **Superclass match** — argument types are subclasses of declared parameter types (using `isSubclass`)
3. **Union match** — argument types intersect a declared union type
4. **Any match** — the signature accepts `any` for that parameter position

Within the same priority tier, arity (number of arguments) acts as a tiebreaker — more specific (higher arity) signatures win.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// Given two signatures:
// A: (query: string, repo: string)
// B: (query: string)

// Call with (query: "foo", repo: "bar/baz")
// → A wins: exact match with 2 args vs 1 arg
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// Given two signatures:
// A: (query: String, repo: String)
// B: (query: String)

// Call with (query: "foo", repo: "bar/baz")
// → A wins: exact match with 2 args vs 1 arg
```

</TabItem>
</Tabs>

## `OverloadAmbiguityError`

If two signatures score identically and neither is more specific, an `OverloadAmbiguityError` is thrown:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

do {
    try await runtime.dispatch("search for code", args)
} catch let error as OverloadAmbiguityError {
    // error.candidates — the ambiguous implementations
    print("Ambiguous overload:", error.candidates)
}
```

</TabItem>
</Tabs>

Resolve ambiguity by making signatures more specific, or by adding a discriminating parameter.

## Semantic overloads (compiler-generated)

The compiler can automatically generate semantic overload groups. When two tools have description similarity above `overloadThreshold`, the compiler groups them under one selector and creates overload entries for each:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolCompiler } from '@smallchat/core';

const compiler = new ToolCompiler(embedder, vectorIndex);
const result = await compiler.compile(manifests, {
  overloadThreshold: 0.88,  // group tools with similarity >= 0.88
});

// result.overloadGroups lists all auto-generated groups
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let compiler = ToolCompiler(embedder: embedder, vectorIndex: vectorIndex)
let result = try await compiler.compile(manifests, options: CompileOptions(
    overloadThreshold: 0.88  // group tools with similarity >= 0.88
))

// result.overloadGroups lists all auto-generated groups
```

</TabItem>
</Tabs>

This is "Phase 2.5" of the compile pipeline — optional but useful for large provider sets where tools naturally cluster by semantic domain.

## Arity tiebreaker

When type scores are equal, arity comparison prefers:

- **Higher arity** wins over lower arity (more specific)
- **Required-only arity** is compared first; optional parameters are counted separately

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
// A: (query: string, language: string, repo: string)  — arity 3
// B: (query: string, language: string)                — arity 2
// C: (query: string)                                  — arity 1

// All arguments provided → A wins
// Only query + language → B wins
// Only query → C wins
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// A: (query: String, language: String, repo: String)  — arity 3
// B: (query: String, language: String)                — arity 2
// C: (query: String)                                  — arity 1

// All arguments provided → A wins
// Only query + language → B wins
// Only query → C wins
```

</TabItem>
</Tabs>

## `OverloadEntry` and `OverloadResolutionResult`

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
struct OverloadEntry {
    var selector: ToolSelector
    var signature: SCMethodSignature
    var implementation: ToolIMP
    var priority: Int?  // explicit priority override
}

struct OverloadResolutionResult {
    var entry: OverloadEntry
    var matchQuality: MatchQuality  // .exact, .superclass, .union, .any
    var score: Double               // 0–1
}

enum MatchQuality {
    case exact
    case superclass
    case union
    case any
}
```

</TabItem>
</Tabs>
