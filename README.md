# ToolKit

> "The big idea is messaging." — Alan Kay

A message-passing tool compiler inspired by the Smalltalk/Objective-C runtime. ToolKit models LLM tool use as message dispatch: the LLM expresses intent, and the runtime resolves it to concrete implementations.

## v0.0.1 — Draft Implementation

This is the initial draft implementing the core architecture:

- **Selector Table** — semantic interning of tool intents (like `sel_registerName`)
- **Resolution Cache** — LRU cache for resolved dispatches (like `objc_msgSend`'s inline cache)
- **ToolClass** — provider grouping with dispatch tables and superclass chains
- **ToolProxy** — lazy schema loading (like `NSProxy`)
- **toolkit_dispatch** — the hot path for intent → tool resolution
- **ToolRuntime** — top-level runtime with swizzling support
- **Compiler** — parse → embed → link pipeline
- **CLI** — `toolkit compile`, `toolkit inspect`, `toolkit resolve`

### Concept Mapping

| Smalltalk / Obj-C | ToolKit |
|---|---|
| Object | ToolProvider (MCP server, API, local function) |
| Class | ToolClass (group of related tools) |
| SEL | ToolSelector (semantic fingerprint of intent) |
| IMP | ToolIMP (concrete implementation) |
| Method = SEL + IMP | ToolMethod |
| Message send | `toolkit_dispatch(context, intent, args)` |
| Method cache | Resolution cache (intent → resolved tool) |
| Protocol | ToolProtocol (capability interface) |
| Category | ToolCategory (capability extension) |
| `respondsToSelector:` | `canHandle(selector)` |
| `forwardInvocation:` | Forwarding chain |
| NSProxy | ToolProxy (lazy schema loading) |

## Quick Start

```bash
npm install
npm run build

# Compile tool definitions
npx toolkit compile --source ./examples --output tools.toolkit.json

# Inspect the compiled artifact
npx toolkit inspect tools.toolkit.json --providers --selectors

# Test dispatch resolution
npx toolkit resolve tools.toolkit.json "search for code"
```

## Development

```bash
npm test          # Run tests
npm run dev       # Watch mode TypeScript compilation
npm run lint      # Type check
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document.

## v0.0.1 Limitations

- **Hash-based embeddings**: Uses a deterministic hash embedder as placeholder. Real semantic embeddings (all-MiniLM-L6-v2 via ONNX) planned for v0.1.
- **No real transport**: Tool execution is stubbed. MCP/REST/gRPC transports planned for Phase 1.
- **In-memory vector index**: Brute-force cosine similarity. sqlite-vec/HNSW planned for production.
- **No LLM disambiguation**: Multiple-candidate resolution takes the best match. LLM-assisted disambiguation planned for Phase 3.
- **JSON output**: Compiled artifacts are JSON. SQLite format planned for Phase 4.
