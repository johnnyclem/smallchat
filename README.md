# smallchat

> Semantic tool dispatch. The agent knows what to do — smallchat figures out which tool does it.

[smallchat.dev](https://smallchat.dev)

---

Your agent has 50 tools. The LLM sees all 50 in its context window every single turn, burning tokens and degrading selection accuracy. You write routing logic, maintain tool registries, and pray the model picks the right one.

**smallchat infers which tool to call.** The LLM expresses intent. The runtime resolves it — semantically, deterministically, in microseconds, with an auditable proof of *why* — and self-heals when nothing matches cleanly. No prompt stuffing. No selection lottery.

> **Tool inference is the durable idea.** Compiling tools out of the context window saves tokens — a real win *today*. But token prices fall. What does not get cheaper is choosing the *right* tool from thousands, deterministically, in microseconds, with a proof you can audit and govern. smallchat is built so that the token savings are a present-era *benefit* of tool inference, not its reason to exist. Even when tokens cost nothing, the inference engine still earns its place.

> **Dispatch, not retrieval.** smallchat is not a knowledge engine or a RAG layer — it doesn't compile documents or answer questions. It infers *which tool to call* from a natural-language intent. The data substrate is your agent's tool registry (`.toolkit.json`), not enterprise documents.

```bash
npx @smallchat/core compile --source ~/.mcp.json
```

One command. Point it at your MCP config, a directory of manifests, or any MCP server repo. Out comes a compiled artifact with embedded vectors, dispatch tables, and resolution caching — ready to serve.

## Where smallchat fits

An agent in production needs two things: **what it knows** and **what it can do**. These are solved at different layers.

| Layer | Problem | Example |
|-------|---------|---------|
| Knowledge layer | Pre-compile documents and data into governed, answer-shaped artifacts so the agent answers from a resolved source instead of re-deriving it. (Moving retrieval upstream also cuts tokens.) | RAG pipelines, enterprise knowledge engines |
| **Dispatch layer** | **Infer *which tool to call* from a natural-language intent — semantically, deterministically, in microseconds, with an auditable resolution proof. (Moving tool-selection upstream also cuts tokens.)** | **smallchat** |

> The parenthetical token savings is what sells the idea in 2026. The deterministic, auditable selection is what keeps it useful after that.

smallchat runs **in the agent process** — no SaaS dependency, no external round-trip. Your tool registry lives with your agent.

An agent backed by any knowledge engine still has to decide whether to run a query, post to Slack, or write a file. That decision is exactly what smallchat handles. The two layers compose cleanly:

> **Use your knowledge engine for what the agent knows. Use smallchat for what the agent does.**

## Quick Start

Get up and running in under a minute:

```bash
# Install smallchat
npm install -g @smallchat/core

# Run the interactive setup wizard
smallchat setup
```

The setup wizard will:
1. **Discover** your existing MCP server configurations (Claude Code, Gemini CLI, OpenCode, Codex, or any `.mcp.json`)
2. **Compile** them into an optimized smallchat toolkit with embedded vectors and dispatch tables
3. **Optionally replace** your `mcpServers` config so all tools are served through smallchat

That's it — your agent now dispatches tools semantically instead of stuffing them all into the context window.

> **Prefer non-interactive mode?** Run `smallchat setup --no-interactive` to auto-detect and compile without prompts.

## Install

```bash
npm install @smallchat/core
```

Requires Node.js >= 20.

> **Swift:** the Swift implementation lives in its own repository — [github.com/johnnyclem/smallchat-swift](https://github.com/johnnyclem/smallchat-swift).

## See It Work

```bash
# Compile tools from your MCP servers
npx @smallchat/core compile --source ~/.mcp.json

# Ask it a question — see which tool it picks and why
npx @smallchat/core resolve tools.toolkit.json "search for code"

# Start an MCP-compatible server
npx @smallchat/core serve --source ./manifests --port 3001

# Scaffold a new project
npx @smallchat/core init my-app --template agent

# Interactive REPL
npx @smallchat/core repl tools.toolkit.json
```

## Use It in Code

For the durable engine and nothing else, import the dedicated entry point — it
excludes the token-era optimization satellites (compaction, memex, CRDT, …):

```typescript
import { ToolRuntime, MemoryVectorIndex, LocalEmbedder } from '@smallchat/core/inference';
```

Or from the package root, which additionally re-exports the satellites:

```typescript
import { ToolRuntime, MemoryVectorIndex, LocalEmbedder } from '@smallchat/core';

const runtime = new ToolRuntime(
  new MemoryVectorIndex(),
  new LocalEmbedder(),
);

const result = await runtime.dispatch('find flights', { to: 'NYC' });

// Fluent API with TypeScript inference
const content = await runtime
  .intent<{ to: string }>('find flights')
  .withArgs({ to: 'NYC' })
  .execContent<FlightResult>();

// Or stream token-by-token
for await (const token of runtime.inferenceStream('find flights', { to: 'NYC' })) {
  process.stdout.write(token);
}
```

## What's New in 0.5.0

- **LoomMCP integration guide** — Compile [LoomMCP](https://muhnehh.github.io/loom-mcp/)'s 17 MCP tools through smallchat for semantic dispatch on top of exact-symbol retrieval. See the [LoomMCP integration page](./packages/docs/docs/integrations/loom-mcp.md).
- **Synchronized package versions** — Every workspace package is now aligned at 0.5.0.
- **Refreshed runtime version metadata** — MCP server, channel server, MCP client, REPL banner, and compiled artifacts now report 0.5.0.

Plus everything from 0.4.0:

- **Confidence-tiered dispatch** — Every dispatch returns EXACT/HIGH/MEDIUM/LOW/NONE and branches accordingly
- **Resolution proof** — Serializable trace documenting why a tool was chosen
- **Pre-flight verification** — `respondsToSelector:` gate between resolution and execution
- **Intent decomposition** — `doesNotUnderstand:` handler breaks complex intents into sub-intents
- **Refinement protocol** — `forwardInvocation:` dialogue for NONE-confidence dispatches
- **Observation & adaptation** — KVO-inspired observer adapts thresholds in real time

See the full [Changelog](./CHANGELOG.md) for details.

## How It Works

smallchat borrows its architecture from the Smalltalk/Objective-C runtime. Tools are objects. Intents are messages. Dispatch is semantic.

The LLM says *what* it wants. The runtime figures out *which tool* handles it — using vector similarity, resolution caching, superclass traversal, and fallback chains. No routing code. No tool selection prompts.

See the [Architecture doc](./ARCHITECTURE.md) for the full design and the [Reference](./docs/REFERENCE.md) for runtime details, dispatch mechanics, and the concept mapping from Smalltalk/Obj-C to smallchat.

## CLI

| Command | Description |
|---------|-------------|
| `setup` | Auto-detect MCP servers and run an interactive compile wizard |
| `init` | Scaffold a new project from a template |
| `compile` | Compile manifests into a dispatch artifact |
| `serve` | Start an MCP-compatible server |
| `resolve` | Test intent-to-tool resolution |
| `inspect` | Examine a compiled artifact |
| `doctor` | Check your environment |
| `docs` | Generate Markdown docs from a compiled artifact |
| `repl` | Interactive shell for testing resolution |
| `channel` | Claude Code channel-protocol bridge |
| `dream` | Memory-driven recompilation from session logs |
| `memex` | Compile a knowledge base (separate from the tool dispatch pipeline) |
| `app` | Compile and inspect MCP Apps Extension manifests |
| `rtk` | RTK output-compression setup and tooling |

## Packages

| Package | Description |
|---------|-------------|
| `@smallchat/core` | Core runtime, compiler, MCP server, CLI |
| `@smallchat/react` | React hooks: `useToolDispatch`, `useToolStream`, `SmallchatProvider` |
| `@smallchat/nextjs` | Next.js App Router helpers |
| `@smallchat/testing` | `MockEmbedder`, `MockVectorIndex`, assertion helpers |
| `smallchat-vscode` | VS Code syntax highlighting, manifest schema validation, snippets |
| `@smallchat/playground` | Browser-based resolution chain visualizer |

## Documentation

| Doc | What's inside |
|-----|---------------|
| [Quickstart](./QUICKSTART.md) | Zero to dispatching in 5 minutes |
| [Architecture](./ARCHITECTURE.md) | Full design document |
| [Reference](./docs/REFERENCE.md) | Runtime, dispatch, streaming, MCP server, CLI details |
| [Concept Mapping](./docs/REFERENCE.md#concept-mapping) | Smalltalk/Obj-C → smallchat translation table |
| [Migration Guide](./MIGRATION.md) | Upgrading from 0.1.0 to 0.2.0 |
| [LoomMCP integration](./packages/docs/docs/integrations/loom-mcp.md) | Pair smallchat with LoomMCP for semantic dispatch over symbol-level retrieval |
| [Changelog](./CHANGELOG.md) | Release history |

## Ecosystem

smallchat is one of four related projects by the same author (AgentVault, SmallChat, Stenographer,
Short-Hand) exploring a layered agent runtime — durable execution, tool dispatch, conversation
memory, and context compaction as separate concerns. See
[`docs/ecosystem/executive-summary.md`](./docs/ecosystem/executive-summary.md) and
[`docs/ecosystem/engineering-guide.md`](./docs/ecosystem/engineering-guide.md) for what's actually
wired up today (notably: Short-Hand's compaction and CRDT modules are vendored directly into this
package) versus what's still aspirational.

## Development

```bash
npm test          # ~1,250+ specs across the core runtime, compiler, embeddings, and transports
npm run dev       # Watch mode
npm run lint      # Type check
npm run docs:api  # Generate API reference
```

## License

MIT
