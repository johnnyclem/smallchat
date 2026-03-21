---
title: Selector Table
sidebar_label: Selector Table
---

# Selector Table

The `SelectorTable` is the semantic interning layer — analogous to `sel_registerName` in the Objective-C runtime. It ensures that semantically equivalent intent strings resolve to the same canonical `ToolSelector`, deduplicated by vector similarity.

## How semantic interning works

When the compiler processes a tool description like `"Search for code across GitHub repositories"`, it:

1. Embeds the string into a vector using the configured `Embedder`
2. Checks whether any existing selector has cosine similarity ≥ `selectorThreshold` (default 0.95)
3. If yes, returns the existing selector (deduplication)
4. If no, registers a new `ToolSelector` and stores its embedding

At runtime, when an intent arrives (`"search for code"`), `SelectorTable.resolve()` embeds the intent and performs a nearest-neighbor search over registered selectors. The top match above `minConfidence` wins.

## The `sel_registerName` analogy

In Objective-C, `sel_registerName("methodName:")` returns a global `SEL` token. Two strings that are byte-identical always yield the same `SEL`. smallchat generalises this: two strings that are **semantically** equivalent (cosine similarity ≥ threshold) yield the same `ToolSelector`.

This means:

- `"search for code"` and `"find code"` → same selector → same tool
- `"create an issue"` and `"open a bug report"` → same selector → `github.create_issue`
- `"delete a file"` and `"remove a file"` → same selector → `filesystem.delete_file`

Deduplication happens at compile time. The runtime only performs lookup.

## Deduplication threshold

The `selectorThreshold` controls how aggressively selectors are deduplicated:

| Value | Behaviour |
|---|---|
| 0.99 | Only near-identical strings merge. `"search code"` and `"search for code"` stay separate. |
| 0.95 (default) | Close paraphrases merge. Most production deployments use this. |
| 0.85 | Aggressive merging. Different-domain intents may incorrectly collapse. |

Set it in `RuntimeOptions`:

```typescript
const runtime = new ToolRuntime({
  selectorThreshold: 0.95,
  embedder,
  vectorIndex,
});
```

## Collision detection

When two tools from different providers produce the same canonical selector, the compiler emits a `SelectorCollision` warning:

```typescript
export interface SelectorCollision {
  selector: string;
  tools: string[];  // e.g. ['github.search_code', 'gitlab.search_code']
}
```

Collisions are reported in `CompilationResult.collisions` and can be resolved by:

1. Adjusting `selectorThreshold` upward
2. Adding a more specific description to differentiate tools
3. Using `OverloadTable` to handle both under one selector

## API: `SelectorTable.intern()`

```typescript
class SelectorTable {
  // Register an intent string and return its canonical selector.
  // If a similar selector already exists (cosine >= threshold), returns that.
  intern(intent: string, embedding: number[]): ToolSelector;

  // Look up the best-matching selector for an intent.
  // Returns null if no match exceeds minConfidence.
  resolve(intent: string, embedding: number[]): ToolSelector | null;

  // Get all registered selectors.
  all(): ToolSelector[];

  // Check if a selector string is registered.
  has(selector: string): boolean;
}
```

## `canonicalize()`

The top-level `canonicalize()` helper normalises an intent string before embedding — lowercasing, stripping punctuation, collapsing whitespace:

```typescript
import { canonicalize } from '@smallchat/core';

canonicalize('Search for Code!') // → 'search for code'
canonicalize('  find   code  ')  // → 'find code'
```

This improves deduplication quality when intent strings vary in casing or punctuation.
