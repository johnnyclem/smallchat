---
title: Deep Dive
sidebar_label: Overview
---

# Deep Dive

This section documents the internals of smallchat for engineers who want to understand or extend the runtime.

## The runtime model

```
┌─────────────────────────────────────────┐
│              ToolRuntime                │
│  dispatch("find flights", { to: "NYC"}) │
├─────────────────────────────────────────┤
│           DispatchContext               │
│  selector table · resolution cache     │
│  overload tables · forwarding chain    │
├─────────────────────────────────────────┤
│             ToolClass                   │
│  dispatch table (selector → IMP)       │
│  protocols · categories · superclass   │
├─────────────────────────────────────────┤
│     SelectorTable · VectorIndex        │
│  semantic interning · cosine lookup    │
└─────────────────────────────────────────┘
```

Each layer has a focused responsibility:

| Layer | Responsibility |
|---|---|
| `ToolRuntime` | Public API, configuration, lifecycle |
| `DispatchContext` | Per-dispatch state: selector table, cache, overloads, fallback chain |
| `ToolClass` | Provider grouping, dispatch table, protocol conformance |
| `SelectorTable` | Semantic interning of intent strings |
| `VectorIndex` | Cosine similarity search |
| `ResolutionCache` | LRU cache for resolved dispatches |
| `OverloadTable` | Multiple signatures per selector |

## What is covered in this section

- **[Selector Table](./selector-table)** — how intent strings are deduplicated and fingerprinted
- **[Dispatch](./dispatch)** — the hot path: `toolkit_dispatch` and `smallchat_dispatchStream`
- **[ToolClass & ToolProxy](./tool-class)** — provider grouping, superclass chains, lazy loading
- **[Resolution Cache](./resolution-cache)** — LRU cache mechanics and version tagging
- **[SCObject System](./sc-object)** — NSObject-inspired parameter hierarchy
- **[Function Overloading](./overloading)** — multiple implementations per selector
- **[Streaming](./streaming)** — three tiers, event sequence, cancellation
- **[Method Swizzling](./swizzling)** — runtime method replacement for testing and routing

## Key source files

| Concept | Source file |
|---|---|
| SelectorTable | `src/core/selector-table.ts` |
| ResolutionCache | `src/core/resolution-cache.ts` |
| ToolClass, ToolProxy | `src/core/tool-class.ts` |
| OverloadTable | `src/core/overload-table.ts` |
| SCObject hierarchy | `src/core/sc-object.ts` |
| Type system | `src/core/sc-types.ts` |
| Dispatch hot path | `src/runtime/dispatch.ts` |
| ToolRuntime | `src/runtime/runtime.ts` |
| Compiler | `src/compiler/compiler.ts` |
| MCPServer | `src/mcp/index.ts` |
