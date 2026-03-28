# smallchat

> Object-oriented inference. A tool compiler for the age of agents.

[smallchat.dev](https://smallchat.dev)

---

Your agent has 50 tools. The LLM sees all 50 in its context window every single turn, burning tokens and degrading selection accuracy. You write routing logic, maintain tool registries, and pray the model picks the right one.

**smallchat compiles your tools into a dispatch table.** The LLM expresses intent. The runtime resolves it — semantically, deterministically, in microseconds. No prompt stuffing. No selection lottery.

```bash
npx @smallchat/core compile --source ~/.mcp.json
```

One command. Point it at your MCP config, a directory of manifests, or any MCP server repo. Out comes a compiled artifact with embedded vectors, dispatch tables, and resolution caching — ready to serve.

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

## What's New in 0.2.0

- **Claude Code channel protocol** — Bidirectional integration with Claude Code
- **Security hardening** — Intent pinning, selector namespacing, semantic rate limiting, container sandboxing
- **Worker thread embeddings** — Non-blocking ONNX inference and SQLite vector search
- **SQLite artifact persistence** — Durable compiled artifact storage
- **Fluent SDK API** — Chainable `runtime.intent().withArgs().exec()` with full TypeScript inference
- **New CLI commands** — `init`, `docs`, `repl` for project scaffolding, documentation, and interactive exploration
- **Satellite packages** — `@smallchat/react`, `@smallchat/nextjs`, `@smallchat/testing`, VS Code extension, Playground UI
- **274+ test specs** — Comprehensive Gherkin-style coverage across all modules

See the full [Changelog](./CHANGELOG.md) for details.

## How It Works

smallchat borrows its architecture from the Smalltalk/Objective-C runtime. Tools are objects. Intents are messages. Dispatch is semantic.

The LLM says *what* it wants. The runtime figures out *which tool* handles it — using vector similarity, resolution caching, superclass traversal, and fallback chains. No routing code. No tool selection prompts.

See the [Architecture doc](./ARCHITECTURE.md) for the full design and the [Reference](./docs/REFERENCE.md) for runtime details, dispatch mechanics, and the concept mapping from Smalltalk/Obj-C to smallchat.

## CLI

| Command | Description |
|---------|-------------|
| `compile` | Compile manifests into a dispatch artifact |
| `serve` | Start an MCP-compatible server |
| `resolve` | Test intent-to-tool resolution |
| `inspect` | Examine a compiled artifact |
| `doctor` | Check your environment |
| `init` | Scaffold a new project from a template |
| `docs` | Generate Markdown docs from a compiled artifact |
| `repl` | Interactive shell for testing resolution |

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
| [Changelog](./CHANGELOG.md) | Release history |

## Development

```bash
npm test          # 274+ specs
npm run dev       # Watch mode
npm run lint      # Type check
npm run docs:api  # Generate API reference
```

## License

MIT
