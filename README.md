# smallchat

> Object-oriented inference. A tool compiler for the age of agents.

[smallchat.dev](https://smallchat.dev)

---

Your agent has 50 tools. The LLM sees all 50 in its context window every single turn, burning tokens and degrading selection accuracy. You write routing logic, maintain tool registries, and pray the model picks the right one.

**smallchat compiles your tools into a dispatch table.** The LLM expresses intent. The runtime resolves it — semantically, deterministically, in microseconds. No prompt stuffing. No selection lottery.

```bash
npx smallchat compile --source ~/.mcp.json
```

One command. Point it at your MCP config, a directory of manifests, or any MCP server repo. Out comes a compiled artifact with embedded vectors, dispatch tables, and resolution caching — ready to serve.

## Install

```bash
npm install @smallchat/core
```

Requires Node.js >= 20.

## See It Work

```bash
# Compile tools from your MCP servers
npx smallchat compile --source ~/.mcp.json

# Ask it a question — see which tool it picks and why
npx smallchat resolve tools.toolkit.json "search for code"

# Start an MCP-compatible server
npx smallchat serve --source ./manifests --port 3001
```

## Use It in Code

```typescript
import { ToolRuntime, MemoryVectorIndex, LocalEmbedder } from 'smallchat';

const runtime = new ToolRuntime(
  new MemoryVectorIndex(),
  new LocalEmbedder(),
);

const result = await runtime.dispatch('find flights', { to: 'NYC' });

// Or stream token-by-token
for await (const token of runtime.inferenceStream('find flights', { to: 'NYC' })) {
  process.stdout.write(token);
}
```

## How It Works

smallchat borrows its architecture from the Smalltalk/Objective-C runtime. Tools are objects. Intents are messages. Dispatch is semantic.

The LLM says *what* it wants. The runtime figures out *which tool* handles it — using vector similarity, resolution caching, superclass traversal, and fallback chains. No routing code. No tool selection prompts.

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

### Embeddings & Vector Search

smallchat provides two embedding strategies and two vector index backends:

| Component | Implementation | Use case |
|-----------|---------------|----------|
| **LocalEmbedder** | Deterministic hash-based | Fast development, testing, CI |
| **ONNXEmbedder** | all-MiniLM-L6-v2 via ONNX Runtime (384-dim) | Production semantic matching |
| **MemoryVectorIndex** | In-memory brute-force cosine similarity | Development, small tool sets |
| **SqliteVectorIndex** | sqlite-vec with persistent storage | Production, large tool sets |

The ONNX model ships with the package in `models/` (quantized, ~22MB). This is a deliberate tradeoff: bundling the model means `npm install` gives you working semantic dispatch with zero extra setup, but it does add ~22MB to your `node_modules`. If install size is a concern, use `LocalEmbedder` + `MemoryVectorIndex` for a zero-model-dependency setup (hash-based embeddings, no ONNX download).

### MCP Server

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

### Cache Versioning & Hot Reload

Resolution cache entries are tagged with provider version, model version, and schema fingerprint (DJB2 hash). Entries are automatically evicted on version changes, enabling hot-reload workflows. Invalidation hooks allow subscribing to flush, provider, selector, and staleness events.

### Method Swizzling

Replace any tool implementation at runtime:

```typescript
const original = runtime.swizzle(toolClass, selector, newImp);
// Cache entries for that selector are automatically flushed
```

## CLI

| Command | Description |
|---------|-------------|
| `compile` | Compile manifests into a dispatch artifact |
| `serve` | Start an MCP-compatible server |
| `resolve` | Test intent-to-tool resolution |
| `inspect` | Examine a compiled artifact |
| `doctor` | Check your environment |

## Documentation

| Doc | What's inside |
|-----|---------------|
| [Quickstart](./QUICKSTART.md) | Zero to dispatching in 5 minutes |
| [Architecture](./ARCHITECTURE.md) | Full design document |
| [Reference](./docs/REFERENCE.md) | Runtime, dispatch, streaming, MCP server, CLI details |
| [Concept Mapping](./docs/REFERENCE.md#concept-mapping) | Smalltalk/Obj-C → smallchat translation table |
| [Changelog](./CHANGELOG.md) | Release history |

## Development

```bash
npm test          # 274 specs
npm run dev       # Watch mode
npm run lint      # Type check
```

## License

MIT
