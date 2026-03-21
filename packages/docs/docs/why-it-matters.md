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
- If nothing matches, the fallback chain provides graceful degradation

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
| Bundle size | Multiple adapter packages | &lt; 5 MB, zero dependencies |
| Architecture | Framework owns your loop | You own your loop |

## Zero dependencies

`@smallchat/core` ships under 5 MB with zero runtime dependencies. The local embedder runs entirely in-process — no external API call required for embedding or dispatch. Add a provider client when you need actual tool execution.

## MCP native

smallchat implements the **MCP 2025-11-25** specification. The built-in `MCPServer` exposes a standards-compliant HTTP/SSE endpoint so any MCP-aware LLM client can discover and call your tools without any custom integration code.

```bash
# Your tools, available to any MCP client, in one command
npx @smallchat/core serve ./tools --port 3001
```
