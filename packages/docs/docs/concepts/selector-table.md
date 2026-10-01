---
title: Selector Table
sidebar_label: Selector Table
---

# Selector Table

The `SelectorTable` holds the compiled **tool selectors** — the dispatch keys
of every tool — and their vectors. It is the analogue of the table behind
`sel_registerName` in the Objective-C runtime, with one difference: a
selector is a semantic fingerprint (an embedding), and intents are matched
against selectors by cosine similarity.

This page describes `@smallchat/core` 1.0 (TypeScript).

## Tool selectors only

- The compiler registers one selector per tool, under its exact canonical
  name (`<providerId>.<toolName>`, or a `pinSelector`), plus one per alias
  (`<canonical>~alias~<phrase>`). Two distinct tools never share a selector:
  tools whose embeddings are ≥ 0.95 cosine-similar are a compile error
  (`DuplicateToolError`) unless compiled with `--allow-duplicates`, and an
  alias phrase can belong to only one tool.
- A runtime intent is **never interned**. `resolve()` / `dispatch()` embed
  the intent on its own (`intentSelector()`, keyed by `intentKey()`: the full
  text, NFC-normalized, trimmed, whitespace-collapsed, lower-cased) and search
  the tool selectors. Intents therefore never appear in `all()`, never shadow
  a tool in "did you mean?" suggestions, and never change how a later intent
  ranks.

## Matching

`searchTools(vector, topK, threshold)` returns the nearest tool selectors.
Similarities are quantized to 4 decimal places and equal scores are ordered
by canonical tool id (`spec/ranking/`), so the same intent against the same
artifact always produces the same candidate order. Resolution then turns
candidates into an outcome with tiers and the dispatch policy (see
[Dispatch](./dispatch)).

## Collision zones

Distinct tools that embed close together (≥ 0.89 by default, below the
duplicate threshold) are reported in `CompilationResult.collisions` and in
the artifact: an intent near both may resolve to `needs-disambiguation`.
Give them more specific descriptions, a `selectorHint`, or call them by tool
id.

## API

```typescript
class SelectorTable {
  /** Register a tool or alias selector under its exact canonical name. */
  register(embedding: Float32Array, canonical: string): ToolSelector;
  /** The selector with this canonical name. */
  get(canonical: string): ToolSelector | undefined;
  /** Nearest tool selectors at or above `threshold` (quantized). */
  searchTools(vector: Float32Array, topK: number, threshold: number): Promise<SelectorMatch[]>;
  /** Every tool selector. */
  all(): ToolSelector[];
  readonly size: number;
}
```

`intern(embedding, canonical)` (fold into an existing selector at ≥ the
table threshold) remains for building tables by hand; the compiler and
`loadRuntime` use `register()`.

## `intentKey()` and `canonicalize()`

```typescript
import { intentKey, canonicalize } from '@smallchat/core';

intentKey('  Do NOT delete   the logs ') // → 'do not delete the logs' (identity)
canonicalize('Do not delete the logs')    // → 'delete:logs' (display only)
```

`intentKey()` is the identity of an intent (the resolution cache, the
semantic map's exact lookups and feedback use it). `canonicalize()` drops
stopwords — "not" included — and is for display only.
