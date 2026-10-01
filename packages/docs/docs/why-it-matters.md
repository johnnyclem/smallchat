---
title: Why it matters
sidebar_label: Why it matters
---

# Why it matters

## The problem: tool proliferation

Modern AI applications integrate with dozens of tools — search, databases, filesystems, APIs, internal services. As tool counts grow, routing becomes the bottleneck. The naive approaches all break at scale:

**String matching** — `if (intent.includes("search")) callSearchTool()`. Brittle. Misses paraphrases. Fails in production.

**Prompt stuffing** — dump all tool schemas into the system prompt and let the model pick. Works until you have 30 tools. Then the context window fills up, latency spikes, and accuracy drops.

**Hand-crafted routing tables** — explicit `{ "search for code": searchCode }` maps. Requires continuous maintenance. Breaks on any variation in LLM output phrasing.

**Agent loops** — let the model pick tools autonomously on every call. Expensive. Unpredictable latency. Hard to cache.

## The solution: semantic dispatch

smallchat treats tool routing as a **message dispatch problem**, borrowing the solution from the Objective-C runtime.

The insight is simple: tool intent and tool description exist in the same semantic space. If you embed both at compile time and use cosine similarity at runtime, you get robust routing that:

- Handles paraphrases: `"search for code"` and `"find code in a repo"` resolve to the same tool
- Caches hot paths: repeat dispatches skip the embedding entirely
- Degrades gracefully: confidence scores tell you when to fall back
- Stays fast: the hot path is a cache lookup + hash table walk

## The Obj-C runtime inspiration

Alan Kay's key insight — "the big idea is messaging" — applies directly to LLM tool use. In Objective-C:

- Objects respond to selectors (method names)
- `objc_msgSend` looks up the selector in a dispatch table, walks the class hierarchy if needed, and invokes the implementation
- An inline cache avoids the lookup on repeat calls
- If nothing responds, `forwardInvocation:` provides a fallback

smallchat maps this model directly:

- ToolProviders respond to ToolSelectors (semantic fingerprints)
- `toolkit_dispatch` looks up the selector in the SelectorTable, walks the ToolClass hierarchy, and invokes the ToolIMP
- The ResolutionCache avoids the embedding on repeat dispatches
- If no tool is chosen with enough confidence, nothing runs: the result says why and lists the candidates to call by id

The mapping is not metaphorical — the implementation structure mirrors the Obj-C runtime deliberately.

## Primitives, not a framework

Most LLM frameworks are opinionated end-to-end systems. They own your agent loop, your memory, your prompts. smallchat is different: it provides one well-defined primitive — the dispatch layer — and gets out of the way.

You decide how to call tools. You decide what to do with the results. You compose with the language itself.

```typescript
// That's it. One call. You own everything else.
const result = await runtime.dispatch('search for code', args);
```

## Comparison

| Concern | LangChain | smallchat |
|---|---|---|
| Streaming | `CallbackManager` + custom piping | `for await` over native provider deltas |
| Tool dispatch | Chain/Agent hierarchy | One `smallchat_dispatchStream` call |
| Caching | External wrappers | Built-in resolution cache |
| Extensibility | Subclass and register | `toolClass.addMethod` or swizzle |
| Runs where | Framework runtime | In your process: embedding and resolution need no network or LLM API |
| Architecture | Framework owns your loop | You own your loop |

## No external services

Embedding runs in-process with the bundled ONNX model (all-MiniLM-L6-v2), so resolving an intent needs no network or LLM API. `@smallchat/core` does have runtime dependencies — the MCP SDK, Ajv, ONNX Runtime, SQLite (`better-sqlite3`, `sqlite-vec`) and `@shorthand/core` — and tools run on their own servers (MCP, REST, local handlers).

## MCP native

`smallchat serve` is an MCP server built on the official SDK, which negotiates the protocol version with each client (2025-11-25 down to 2024-10-07). It serves stdio by default, or Streamable HTTP at `/mcp` with `--http` and a bearer token, and forwards each `tools/call`, by exact name, to the upstream server that owns the tool.

```bash
# Your tools, available to any MCP client, in one command
npx -y @smallchat/core serve --source tools.toolkit.json
```
