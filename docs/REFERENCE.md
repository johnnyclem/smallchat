# smallchat Reference

Detailed documentation for smallchat's runtime, dispatch system, CLI, and MCP server.

## Core Runtime

- **Selector Table** — semantic interning of tool intents (like `sel_registerName`)
- **Resolution Cache** — LRU cache with version tagging and automatic staleness detection
- **ToolClass** — provider grouping with dispatch tables, superclass chains, and overload support
- **ToolProxy** — lazy schema loading (like `NSProxy`)
- **smallchat_dispatch** — the hot path for intent → tool resolution
- **smallchat_dispatchStream** — async generator streaming dispatch with real-time event feedback
- **ToolRuntime** — top-level runtime with swizzling, header generation, and inference streaming

## Streaming & Async Dispatch

smallchat supports three tiers of execution, with automatic fallback:

| Tier | Interface | Granularity | Use case |
|------|-----------|-------------|----------|
| 1 | `executeInference` | Token-level deltas | OpenAI/Anthropic SSE streams |
| 2 | `executeStream` | Chunk-level results | Paginated or batched responses |
| 3 | `execute` | Single-shot | Simple tool calls |

`smallchat_dispatchStream` yields a sequence of typed events:

```
resolving → tool-start → chunk* / inference-delta* → done
```

Cancellation is supported via standard `AbortController` semantics on the async generator.

The runtime exposes a convenience `inferenceStream()` method that yields only token text, filtering out lifecycle events and falling back gracefully through the tiers.

## SCObject Parameter Passing

Inspired by NSObject, smallchat wraps structured data in a type hierarchy for safe tool-to-tool passing:

```
SCObject
├── SCSelector       — tool intent as a passable value
├── SCData           — arbitrary JSON/structured data
├── SCToolReference  — a ToolIMP reference (tool-to-tool dispatch)
├── SCArray          — ordered collection
└── SCDictionary     — key-value collection
```

Primitives (string, number, boolean, null) pass through unwrapped. Objects and arrays auto-wrap/unwrap at dispatch boundaries.

## Function Overloading

Tools can register multiple signatures under the same selector. Resolution picks the best match by type specificity:

1. **Exact** type match
2. **Superclass** match (SCObject hierarchy)
3. **Union** type match
4. **Any** (`id`) — accepts anything
5. Tiebreaker: higher arity preferred

The compiler can also generate **semantic overloads** automatically by clustering tools with similar embeddings but different argument signatures (configurable threshold, default 0.82).

## Fallback Chain

When no exact dispatch match is found, the runtime attempts graceful degradation:

1. **Superclass traversal** — walks ISA chains
2. **Broadened search** — lowers similarity threshold (0.75 → 0.5)
3. **LLM disambiguation** — (stub, planned for Phase 3)

Results include `fallbackSteps` metadata so callers know the resolution path taken.

## Embeddings & Vector Search

smallchat provides two embedding strategies and two vector index backends:

| Component | Implementation | Use case |
|-----------|---------------|----------|
| **LocalEmbedder** | Deterministic hash-based | Fast development, testing, CI |
| **ONNXEmbedder** | all-MiniLM-L6-v2 via ONNX Runtime (384-dim) | Production semantic matching |
| **MemoryVectorIndex** | In-memory brute-force cosine similarity | Development, small tool sets |
| **SqliteVectorIndex** | sqlite-vec with persistent storage | Production, large tool sets |

The ONNX model ships with the package in `models/` (quantized, ~30MB).

## Compile Sources

The `compile` command accepts three types of input:

| Source | Example | What it does |
|--------|---------|--------------|
| **Directory** | `--source ./manifests` | Reads all `.json` manifest files from the directory |
| **MCP config file** | `--source ~/.mcp.json` | Parses `mcpServers`, spawns each server via stdio, and introspects tools via JSON-RPC |
| **Auto-detect** | _(no --source)_ | Detects if cwd is an MCP server repo, builds & introspects it |

**MCP config file format** (used by Claude Desktop, Claude Code `.mcp.json`, etc.):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

When compiling from an MCP config or auto-detecting, smallchat spawns each server, sends `initialize` and `tools/list` over MCP's stdio transport, captures the tool schemas, and generates shareable manifest files alongside the compiled artifact.

## MCP Server

`smallchat serve` starts an HTTP server implementing the MCP 2026 protocol:

| Capability | Description |
|------------|-------------|
| **JSON-RPC** | `initialize`, `tools/list` (paginated), `tools/call` |
| **Resources** | `resources/list`, `resources/read`, `resources/subscribe` with change notifications |
| **Prompts** | `prompts/list`, `prompts/get` with template arguments |
| **SSE** | Server-Sent Events stream with keep-alive |
| **Streaming execution** | `tools/call` with `Accept: text/event-stream` |
| **Sessions** | SQLite-backed session management |
| **OAuth 2.1** | Token-based auth with scopes (`tools:read`, `tools:execute`, `resources:read`, `prompts:read`) |
| **Rate limiting** | Per-session request throttling |
| **Health** | `/health` endpoint with tool count |

## Cache Versioning & Hot Reload

Resolution cache entries are tagged with provider version, model version, and schema fingerprint (DJB2 hash). Entries are automatically evicted on version changes, enabling hot-reload workflows. Invalidation hooks allow subscribing to flush, provider, selector, and staleness events.

## Method Swizzling

Replace any tool implementation at runtime:

```typescript
const original = runtime.swizzle(toolClass, selector, newImp);
// Cache entries for that selector are automatically flushed
```

## LLM Header Generation

`runtime.generateHeader()` produces a token-efficient capability summary for LLM system prompts, including protocol groupings, overload signatures, and instruction text.

## CLI Reference

| Command | Description |
|---------|-------------|
| `smallchat compile` | Parse manifests, embed selectors, link dispatch tables → `.toolkit.json` |
| `smallchat serve` | Start MCP-compatible HTTP server with SSE streaming |
| `smallchat resolve` | Test dispatch resolution against a compiled artifact |
| `smallchat inspect` | Examine providers, selectors, and protocols in a compiled artifact |
| `smallchat doctor` | Check environment: Node version, ONNX model availability, dependencies |

## Example Manifests

The `examples/` directory contains 32 MCP server manifest files for popular services, ready to use with `smallchat compile`:

| Category | Manifests |
|----------|-----------|
| **File & Storage** | filesystem, git, google-drive, dropbox |
| **Code Hosting** | github, gitlab |
| **Project Management** | atlassian (Jira + Confluence), linear, notion |
| **Communication** | slack |
| **Search & Web** | brave-search, fetch, puppeteer, google-maps |
| **Databases** | postgres, sqlite, mongodb, redis, elasticsearch |
| **Cloud & Infra** | aws, azure, cloudflare, firebase |
| **Payments** | stripe |
| **Monitoring** | sentry |
| **Design** | figma, everart |
| **Utilities** | time, memory, sequential-thinking, everything |

A `full-pipeline-example/` shows how to compose multiple providers into a single agent toolkit with semantic overload generation enabled.

## Benchmarks

The `bench/` directory contains a benchmarking suite with 700+ intent-to-tool test cases across easy, medium, and hard difficulty tiers, evaluated against 100+ tool definitions.

Four dispatch strategies are compared:

| Strategy | Method |
|----------|--------|
| **Keyword** | Simple string matching baseline |
| **Embedding-only** | Pure cosine similarity |
| **LLM** | GPT-4 tool selection |
| **smallchat** | Semantic dispatch with caching and fallback chains |

Metrics include top-1 accuracy, top-5 accuracy, acceptable hit rate, and latency. Per-case breakdowns provide explainability for dispatch decisions.

## Concept Mapping

| Smalltalk / Obj-C | smallchat |
|---|---|
| Object | ToolProvider (MCP server, API, local function) |
| Class | ToolClass (group of related tools) |
| SEL | ToolSelector (semantic fingerprint of intent) |
| IMP | ToolIMP (concrete implementation) |
| Method = SEL + IMP | ToolMethod |
| Message send | `smallchat_dispatch(context, intent, args)` |
| Message stream | `smallchat_dispatchStream(context, intent, args)` |
| Method cache | Resolution cache (intent → resolved tool, version-tagged) |
| Protocol | ToolProtocol (capability interface) |
| Category | ToolCategory (capability extension) |
| `respondsToSelector:` | `canHandle(selector)` |
| `forwardInvocation:` | Fallback chain (superclass → broadened → LLM) |
| NSProxy | ToolProxy (lazy schema loading) |
| NSObject | SCObject (typed parameter hierarchy) |

## Current Limitations

- **No LLM disambiguation**: Multiple-candidate resolution takes the best match. LLM-assisted disambiguation planned for Phase 3.
- **JSON output**: Compiled artifacts are JSON. SQLite binary format planned for Phase 4.
