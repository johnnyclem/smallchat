---
title: Function Overloading
sidebar_label: Function Overloading
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Function Overloading

A single `ToolSelector` can map to multiple implementations with different parameter signatures. The `OverloadTable` resolves which implementation to call based on argument types and arity — analogous to method overloading in statically-typed languages, but resolved at runtime.

## Multiple signatures per selector

A `ToolClass` can register several implementations under one of its selectors, each with its own parameter signature (`addOverload`); the class keeps them in an `OverloadTable` for that selector. The compiler never shares a selector between distinct tools, so overloads are registered programmatically, never formed from two providers whose tools happen to embed alike:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolClass, SCType, createSignature, param } from '@smallchat/core';

// `selector` is the class's "search code" selector; the two IMPs run the searches.
const codeSearch = new ToolClass('code-search');

codeSearch.addOverload(selector, createSignature([
  param('query', 0, SCType.string()),
  param('repo', 1, SCType.string()),
]), githubSearchImp, { originalToolName: 'search_in_repo' });

codeSearch.addOverload(selector, createSignature([
  param('query', 0, SCType.string()),
  param('projectId', 1, SCType.number()),
]), gitlabSearchImp, { originalToolName: 'search_in_project' });
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

If two signatures score identically and neither wins the tie-break (higher arity, then an overload you registered over a compiler-generated one), resolving the overload throws `OverloadAmbiguityError`. `OverloadTable.resolve()` and `ToolClass.resolveSelectorWithNamedArgs()` throw it when you call them. Dispatch does not: an ambiguous overload is left out of the candidates (the proof records an `overload` step saying so), so the intent resolves to another candidate or comes back `needs-disambiguation` or `unresolved`.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { OverloadAmbiguityError } from '@smallchat/core';

try {
  codeSearch.resolveSelectorWithNamedArgs(selector, { query: 'parser' });
} catch (e) {
  if (e instanceof OverloadAmbiguityError) {
    // e.candidates — the overload entries that matched equally
    console.error('Ambiguous overload:', e.candidates.map((c) => c.signature.signatureKey));
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

With `generateSemanticOverloads`, the compiler also reports groups of similar tools with different argument signatures (similarity at or above `semanticOverloadThreshold`, default 0.82). In 1.0 these groups are a report: they are listed in `CompilationResult.semanticOverloads` and exempt from duplicate detection, but every tool keeps its own selector, and 1.0 artifacts carry no overload tables, so dispatch does not use them.

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { ToolCompiler } from '@smallchat/core';

const compiler = new ToolCompiler(embedder, vectorIndex, {
  generateSemanticOverloads: true,
  semanticOverloadThreshold: 0.82,
});
const result = await compiler.compile(manifests);

for (const group of result.semanticOverloads) console.log(group);
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
  signature: SCMethodSignature;
  imp: ToolIMP;
  originalToolName?: string;
  isSemanticOverload: boolean;  // compiler-generated (semantic group)
}

export interface OverloadResolutionResult {
  imp: ToolIMP;
  signature: SCMethodSignature;
  matchQuality: MatchQuality;  // 'exact' | 'superclass' | 'union' | 'any'
  entry: OverloadEntry;
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
