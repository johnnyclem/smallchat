# smallchat - object oriented inference

> "The big idea is messaging." — Alan Kay

[smallchat.dev](https://smallchat.dev)

A message-passing tool compiler inspired by the Smalltalk/Objective-C runtime. smallchat models LLM tool use as message dispatch: the LLM expresses intent, and the runtime resolves it to concrete implementations.

## Install

```bash
npm install @smallchat/core
```

## v0.1.0

### Core Runtime

- **Selector Table** — semantic interning of tool intents (like `sel_registerName`)
- **Resolution Cache** — LRU cache with version tagging and automatic staleness detection
- **ToolClass** — provider grouping with dispatch tables, superclass chains, and overload support
- **ToolProxy** — lazy schema loading (like `NSProxy`)
- **smallchat_dispatch** — the hot path for intent → tool resolution
- **smallchat_dispatchStream** — async generator streaming dispatch with real-time event feedback
- **ToolRuntime** — top-level runtime with swizzling, header generation, and inference streaming

### Streaming & Async Dispatch

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

### SCObject Parameter Passing

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

### Function Overloading

Tools can register multiple signatures under the same selector. Resolution picks the best match by type specificity:

1. **Exact** type match
2. **Superclass** match (SCObject hierarchy)
3. **Union** type match
4. **Any** (`id`) — accepts anything
5. Tiebreaker: higher arity preferred

The compiler can also generate **semantic overloads** automatically by clustering tools with similar embeddings but different argument signatures (configurable threshold, default 0.82).

### Fallback Chain

When no exact dispatch match is found, the runtime attempts graceful degradation:

1. **Superclass traversal** — walks ISA chains
2. **Broadened search** — lowers similarity threshold (0.75 → 0.5)
3. **LLM disambiguation** — (stub, planned for Phase 3)

Results include `fallbackSteps` metadata so callers know the resolution path taken.

### Cache Versioning & Hot Reload

Resolution cache entries are tagged with provider version, model version, and schema fingerprint (DJB2 hash). Entries are automatically evicted on version changes, enabling hot-reload workflows. Invalidation hooks allow subscribing to flush, provider, selector, and staleness events.

### Method Swizzling

Replace any tool implementation at runtime:

```typescript
const original = runtime.swizzle(toolClass, selector, newImp);
// Cache entries for that selector are automatically flushed
```

### LLM Header Generation

`runtime.generateHeader()` produces a token-efficient capability summary for LLM system prompts, including protocol groupings, overload signatures, and instruction text.

### Concept Mapping

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

## Quick Start

```bash
npm install
npm run build

# Compile tool definitions
npx smallchat compile --source ./examples --output tools.smallchat.json

# Watch mode — auto-recompile on manifest changes
npx smallchat compile --source ./examples --output tools.smallchat.json --watch

# Inspect the compiled artifact
npx smallchat inspect tools.smallchat.json --providers --selectors

# Test dispatch resolution
npx smallchat resolve tools.smallchat.json "search for code"

# Start MCP-compatible server with SSE streaming
npx smallchat serve --source ./examples --port 3001
```

### Serve Command

`smallchat serve` starts an HTTP server implementing a subset of the MCP protocol:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | POST | JSON-RPC (`initialize`, `tools/list`, `tools/call`) |
| `/health` | GET | Health check with tool count |
| `/sse` | GET | Server-Sent Events stream with keep-alive |
| `tools/call` | POST (Accept: text/event-stream) | Streaming tool execution |

## Example Manifests

The `examples/` directory contains MCP server manifest files for popular services, ready to use with `smallchat compile`:

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

## Development

```bash
npm test          # Run tests (110 specs)
npm run dev       # Watch mode TypeScript compilation
npm run lint      # Type check
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document.

## Current Limitations

- **Hash-based embeddings**: Uses a deterministic hash embedder as placeholder. Real semantic embeddings (all-MiniLM-L6-v2 via ONNX) planned.
- **No real transport**: Tool execution is stubbed. MCP/REST/gRPC transports in progress (serve command is the first step).
- **In-memory vector index**: Brute-force cosine similarity. sqlite-vec/HNSW planned for production.
- **No LLM disambiguation**: Multiple-candidate resolution takes the best match. LLM-assisted disambiguation planned for Phase 3.
- **JSON output**: Compiled artifacts are JSON. SQLite format planned for Phase 4.

## License

MIT
