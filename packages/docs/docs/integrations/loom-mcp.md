---
title: LoomMCP
sidebar_label: LoomMCP
description: Pair smallchat semantic dispatch with LoomMCP exact-symbol retrieval.
---

# LoomMCP

[LoomMCP](https://muhnehh.github.io/loom-mcp/) is an MCP server that turns a codebase into a queryable symbol graph. Instead of paying tokens to re-read whole files, an agent calls one of LoomMCP's 17 tools — `loom_get_topology`, `loom_focus`, `loom_search_refs`, and friends — and gets back exactly the function, class, or reference set it asked for. The project reports an average **97% reduction in tokens** spent reading code.

LoomMCP and smallchat solve adjacent problems:

| Layer | Problem | Tool |
|---|---|---|
| **Retrieval** | "Don't read whole files; fetch the right symbols." | LoomMCP |
| **Dispatch** | "Don't dump 17 tool schemas in the prompt; route the intent." | smallchat |

Wire them together and the agent stops paying twice — once for tool selection, once for source code.

## Why combine them

LoomMCP exposes 17 MCP tools. Surfacing all of them through Claude Code or any MCP client puts every schema in the model's context on every turn — exactly the failure mode smallchat was built to fix. Compile LoomMCP through smallchat and the agent expresses intent ("find every caller of `loginUser`") without ever seeing the tool list. smallchat resolves the intent to `loom_search_refs` semantically and dispatches.

## Install LoomMCP

```bash
npm install -g @loom-mcp/server
```

LoomMCP exposes a live observability dashboard at `http://localhost:2337` once the server is running.

## Compile LoomMCP through smallchat

LoomMCP advertises its tools over the standard MCP `tools/list` endpoint, so smallchat can introspect it directly. Point the compiler at a config that launches LoomMCP as an MCP subprocess:

```json title="loom.mcp.json"
{
  "mcpServers": {
    "loom": {
      "command": "npx",
      "args": ["@loom-mcp/server"],
      "env": {
        "LOOM_PROJECT_ROOT": "."
      }
    }
  }
}
```

Then compile:

```bash
npx @smallchat/core compile --source ./loom.mcp.json --output loom.toolkit.json
```

Output:

```
Compiling tools... ✓ 17 tools from 1 provider embedded.
```

## Verify dispatch resolution

Before wiring it into an agent, sanity-check that natural-language intents land on the right LoomMCP tool:

```bash
npx @smallchat/core resolve loom.toolkit.json "show me the file layout of src"
# Matched: loom.loom_get_topology (confidence: 0.94)

npx @smallchat/core resolve loom.toolkit.json "page in the loginUser function"
# Matched: loom.loom_focus (confidence: 0.92)

npx @smallchat/core resolve loom.toolkit.json "where is loginUser called from?"
# Matched: loom.loom_search_refs (confidence: 0.96)
```

If a confidence score lands in the MEDIUM tier (smallchat 0.4.0+ confidence-tiered dispatch), the runtime will run a verification step before executing — useful when two LoomMCP tools sit close to each other in semantic space (for example `loom_focus` vs. `loom_get_definition`).

## Use it in code

```typescript
import {
  ToolRuntime,
  LocalEmbedder,
  MemoryVectorIndex,
} from '@smallchat/core';

const runtime = new ToolRuntime({
  embedder: new LocalEmbedder(),
  vectorIndex: new MemoryVectorIndex(),
});

await runtime.load('./loom.toolkit.json');

// Three-step LoomMCP workflow expressed as natural-language intents
const topology = await runtime.dispatch('scan the src directory', {
  path: 'src/',
});

const symbol = await runtime.dispatch('focus on the loginUser function', {
  symbol: 'src/auth.ts::loginUser',
});

const refs = await runtime.dispatch('find every caller of loginUser', {
  symbol: 'loginUser',
});
```

The agent never sees `loom_get_topology`, `loom_focus`, or `loom_search_refs` in its context — smallchat resolves each intent to the right LoomMCP tool and forwards the call.

## Serve as a single MCP endpoint

If you want a single MCP server that fronts LoomMCP through smallchat dispatch, run:

```bash
npx @smallchat/core serve --source ./loom.mcp.json --port 3001
```

Point Claude Code, Cursor, or any other MCP client at `http://localhost:3001`. The client sees one tool — smallchat's dispatch tool — and gets LoomMCP's full surface area through it.

## Further reading

- LoomMCP project page — [muhnehh.github.io/loom-mcp](https://muhnehh.github.io/loom-mcp/)
- LoomMCP source — [github.com/muhnehh/loom-mcp](https://github.com/muhnehh/loom-mcp)
- smallchat [What it does](../what-it-does) — the compile → embed → dispatch pipeline
- smallchat [Concepts](../concepts/) — selector tables, resolution caches, and confidence tiers
