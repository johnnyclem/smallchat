# smallchat

> Semantic tool dispatch. The agent knows what to do — smallchat figures out which tool does it.

[smallchat.dev](https://smallchat.dev)

---

Your agent has 50 tools. The LLM sees all 50 in its context window every single turn, burning tokens and degrading selection accuracy. You write routing logic, maintain tool registries, and pray the model picks the right one.

**smallchat infers which tool to call.** The LLM expresses intent. The runtime resolves it — semantically, deterministically (same artifact, embedder and runtime state ⇒ same choice and proof digest), in milliseconds (cache hits in microseconds), with an auditable proof of *why* — and asks instead of guessing when nothing matches cleanly. No prompt stuffing. No selection lottery.

> **Tool inference is the durable idea.** Compiling tools out of the context window saves tokens — a real win *today*. But token prices fall. What does not get cheaper is choosing the *right* tool from thousands, reproducibly, in milliseconds, with a proof you can audit and govern. smallchat is built so that the token savings are a present-era *benefit* of tool inference, not its reason to exist. Even when tokens cost nothing, the inference engine still earns its place.

> **Dispatch, not retrieval.** smallchat is not a knowledge engine or a RAG layer — it doesn't compile documents or answer questions. It infers *which tool to call* from a natural-language intent. The data substrate is your agent's tool registry (`.toolkit.json`), not enterprise documents.

```bash
npx -y @smallchat/core compile --source ~/.mcp.json
```

One command (once 1.0.0 is on npm; until then [build from source](#quick-start)). Point it at your MCP config, a directory of manifests, or any MCP server repo. Out comes a compiled artifact (format 1.0): every tool with its upstream schema and annotations, selector vectors pinned to the embedder that produced them, and a content hash — ready to serve.

## Where smallchat fits

An agent in production needs two things: **what it knows** and **what it can do**. These are solved at different layers.

| Layer | Problem | Example |
|-------|---------|---------|
| Knowledge layer | Pre-compile documents and data into governed, answer-shaped artifacts so the agent answers from a resolved source instead of re-deriving it. (Moving retrieval upstream also cuts tokens.) | RAG pipelines, enterprise knowledge engines |
| **Dispatch layer** | **Infer *which tool to call* from a natural-language intent — semantically, reproducibly (same artifact, embedder and state ⇒ same choice), in milliseconds, with an auditable resolution proof. (Moving tool-selection upstream also cuts tokens.)** | **smallchat** |

> The parenthetical token savings is what sells the idea in 2026. The reproducible, auditable selection is what keeps it useful after that.

smallchat runs **in the agent process** — no SaaS dependency, no external round-trip. Your tool registry lives with your agent.

An agent backed by any knowledge engine still has to decide whether to run a query, post to Slack, or write a file. That decision is exactly what smallchat handles. The two layers compose cleanly:

> **Use your knowledge engine for what the agent knows. Use smallchat for what the agent does.**

## Quick Start

Get up and running in under a minute, from source:

```bash
git clone https://github.com/johnnyclem/smallchat.git
cd smallchat
npm install && npm run build
npm link

# Run the interactive setup wizard
smallchat setup
```

The setup wizard will:
1. **Discover** your existing MCP server configurations (Claude Code, Gemini CLI, OpenCode, Codex, or any `.mcp.json`)
2. **Compile** them into an optimized smallchat toolkit with embedded vectors and dispatch tables
3. **Optionally add** a `smallchat` server (stdio, launched as `npx -y @smallchat/core@<version> serve`) next to your existing `mcpServers`. Your servers stay. If you choose to disable them, they move under `smallchatDisabledMcpServers` in the same file instead of being deleted. A timestamped backup is written first, and (unless `--no-verify`) the toolkit is started over stdio before the config is touched.

That's it: your agent can now reach every upstream tool through one server, with exact provider-qualified names and the `smallchat_resolve` tool for intent lookup.

> **Prefer non-interactive mode?** `smallchat setup --no-interactive` auto-detects and compiles without prompts. Add `--config <file> --install [--disable-originals]` to also update that config.
>
> **Published on npm?** Only `@smallchat/core@0.1.0` is on the registry — well behind this repo (`1.0.0`, unreleased; see [What's New](#whats-new) below), and missing commands like `setup`, `doctor`, `explain` and `replay` entirely. `@smallchat/core@1.0.0` depends on `@shorthand/core@1.0.0`, which is published from the [short-hand](https://github.com/johnnyclem/short-hand) repository first. Build from source as shown above until 1.0.0 ships; watch [CHANGELOG.md](./CHANGELOG.md) for the publish.

## Install

**From source** (recommended until the npm package catches up — see the note above):

```bash
git clone https://github.com/johnnyclem/smallchat.git
cd smallchat
npm install
npm run build
```

**From npm** (once 1.0.0 is published; the registry has only `0.1.0` today):

```bash
npm install @smallchat/core
```

Requires Node.js >= 22.

> **Swift:** the Swift implementation lives in its own repository — [github.com/johnnyclem/smallchat-swift](https://github.com/johnnyclem/smallchat-swift).

## See It Work

```bash
# Compile tools from your MCP servers
smallchat compile --source ~/.mcp.json

# Ask it a question — see which tool it picks and why
smallchat resolve tools.toolkit.json "search for code"
smallchat explain tools.toolkit.json "search for code"

# Pin the decisions that matter: golden traces, exit 1 if one changes
smallchat replay tools.toolkit.json traces/

# Serve every tool through one MCP server (stdio; --http for Streamable HTTP)
# Tools are <provider>__<tool>; each call goes to the upstream server by exact name.
smallchat serve --source tools.toolkit.json

# Scaffold a new project
smallchat init my-app --template agent

# Interactive REPL
smallchat repl tools.toolkit.json
```

(Assumes the `npm link` step from [Quick Start](#quick-start). Once 1.0.0 is published, `npx -y @smallchat/core <command>` runs the same commands without a checkout. Never run the unscoped `smallchat` name with `npx`: that npm name is not this project.)

## Use It in Code

For the durable engine and nothing else, import the dedicated entry point — it
has no transport, MCP or satellite code:

```typescript
import { ToolRuntime, MemoryVectorIndex, HashEmbedder } from '@smallchat/core/inference';
```

Or from the package root, which adds the compiler, artifacts, the MCP server
and clients, transports and the channel bridge. (Compaction, CRDT memory,
importance scoring and truth-ledger interop are `@shorthand/core`'s; memex and
dream are the experimental `@smallchat/core/memex` and `/dream` subpaths.) The
usual starting point is a compiled artifact:

```typescript
import { loadRuntime } from '@smallchat/core';

// The artifact records the embedder its vectors came from (model, SHA-256,
// dims, pooling); loadRuntime builds that embedder or refuses to load.
const { runtime, upstreams } = await loadRuntime('tools.toolkit.json');

// Propose one tool (nothing runs), then run exactly that tool
const resolution = await runtime.resolve('find flights');
if (resolution.outcome === 'resolved') {
  await runtime.dispatchById(resolution.chosen!, { to: 'NYC' });
}

// Or both at once: runs a match the policy allows, else returns an isError
// result whose metadata.outcome says why (e.g. 'needs-disambiguation')
const result = await runtime.dispatch('find flights', { to: 'NYC' });

// Fluent API with TypeScript inference; throws DispatchError if nothing ran
const content = await runtime
  .intent<{ to: string }>('find flights')
  .withArgs({ to: 'NYC' })
  .execContent<FlightResult>();

// Or stream token-by-token
for await (const token of runtime.inferenceStream('find flights', { to: 'NYC' })) {
  process.stdout.write(token);
}

await upstreams.close(); // stops stdio upstream MCP servers
```

## What's New

**1.0.0** (unreleased; see [CHANGELOG](./CHANGELOG.md) and [MIGRATION](./MIGRATION.md) — it is a breaking release):

- **Resolve is separate from execute.** `runtime.resolve(intent)` proposes at most one tool and runs nothing; `dispatchById(toolId, args)` runs exactly the named tool; `dispatch()` runs a match only when the dispatch policy allows it. Anything that ran nothing is an `isError` result with `metadata.outcome` (`DispatchOutcome`), and `execContent()` throws `DispatchError` instead of returning an error payload as content.
- **One dispatch policy on every path.** Below HIGH confidence a tool runs only with an LLM verifier's approval (`requireLLMForSubHighDispatch` is on by default; without an `LLMClient` such matches are `needs-disambiguation`). Destructive tools run only by exact id, a pinned phrase or EXACT similarity. Intent pins gate every tool their selector reaches, overloads and other classes included.
- **Exact by construction.** Arguments are validated against each tool's JSON Schema before anything runs; artifacts (format 1.0) are content-hashed and pinned to the embedder that produced their vectors; every decision carries a replayable proof with a canonical call digest. `spec/` holds the cross-implementation vectors (call digest, tool id, ranking, resolve outcomes, artifact).
- **Intents are never interned.** Runtime intents are embedded on their own and never enter the selector table, so they cannot leak into the tool list, shadow tools in suggestions, or change how later intents rank.
- **`smallchat serve` is an exact MCP aggregator** on the official SDK (stdio by default, Streamable HTTP with a bearer token), with `smallchat_resolve` for semantic lookup; replay, explain and a hash-chained decision log make decisions checkable.
- **The root entry is the inference core.** Compaction, CRDT memory, importance scoring and truth-ledger interop (stenographer's Truth Format v2) come from `@shorthand/core` 1.0, a registry dependency: import `@shorthand/core/<module>` (the `@smallchat/core/compaction`, `/crdt`, `/importance` and `/truth` subpaths re-export it and are deprecated). Memex and dream are experimental (`@smallchat/core/memex`, `@smallchat/core/dream`).

### 0.5.0

- **LoomMCP integration guide** — Compile [LoomMCP](https://muhnehh.github.io/loom-mcp/)'s 17 MCP tools through smallchat for semantic dispatch on top of exact-symbol retrieval. See the [LoomMCP integration page](./packages/docs/docs/integrations/loom-mcp.md).
- **Synchronized package versions** — Every workspace package is now aligned at 0.5.0.
- **Refreshed runtime version metadata** — MCP server, channel server, MCP client, REPL banner, and compiled artifacts now report 0.5.0.

### 0.4.0 — the core dispatch pillars

- **Confidence-tiered dispatch** — Every dispatch returns EXACT/HIGH/MEDIUM/LOW/NONE and branches accordingly
- **Resolution proof** — Serializable trace documenting why a tool was chosen
- **Pre-flight verification** — `respondsToSelector:` gate between resolution and execution
- **Intent decomposition** — `doesNotUnderstand:` handler breaks complex intents into sub-intents
- **Refinement protocol** — `forwardInvocation:` dialogue for NONE-confidence dispatches
- **Observation & feedback** — dispatch observer with an explicit feedback API (negative examples); implicit correction inference is opt-in in 1.0

See the full [Changelog](./CHANGELOG.md) for details.

## How It Works

smallchat borrows its architecture from the Smalltalk/Objective-C runtime. Tools are objects. Intents are messages. Dispatch is semantic.

The LLM says *what* it wants. The runtime proposes *which tool* handles it — by vector similarity against the compiled selectors, ranked and tiered deterministically — and runs it only when the dispatch policy allows; otherwise it asks the caller to choose a tool by id. No routing code. No tool selection prompts.

See the [Architecture doc](./ARCHITECTURE.md) for the full design and the [Reference](./docs/REFERENCE.md) for runtime details, dispatch mechanics, and the concept mapping from Smalltalk/Obj-C to smallchat.

## CLI

| Command | Description |
|---------|-------------|
| `setup` | Auto-detect MCP servers and run an interactive compile wizard |
| `init` | Scaffold a new project from a template |
| `compile` | Compile manifests into a dispatch artifact |
| `serve` | Serve a toolkit as one MCP server that forwards each call, by exact name, to its upstream server |
| `resolve` | Test intent-to-tool resolution |
| `explain` | Candidate table, tiers, policy verdicts and proof digest for one intent |
| `replay` | Check golden traces or a decision log against an artifact (exit 0 pass / 1 mismatch / 2 could not run) |
| `inspect` | Examine a compiled artifact |
| `doctor` | Check your environment, and an artifact against its embedder and index; `--mcp` / `--mcp-source` run the MCP conformance checks |
| `docs` | Generate Markdown docs from a compiled artifact |
| `repl` | Interactive shell for testing resolution |
| `channel` | Claude Code channel-protocol bridge |
| `dream` | *Experimental.* Recompile with usage hints from session logs and memory files (advisory; proposes exclusions, never applies one unless configured) |
| `memex` | *Experimental.* Compile a knowledge base (separate from the tool dispatch pipeline) |
| `app` | Compile and inspect MCP Apps Extension manifests |
| `rtk` | RTK output-compression setup and tooling |

## Packages

All packages are versioned in lockstep (1.0.0); satellites take `@smallchat/core` `^1.0.0` as a peer dependency.

| Package | Description | On npm? |
|---------|-------------|---------|
| `@smallchat/core` | Core runtime, compiler, MCP server, CLI | Only `0.1.0` so far; 1.0.0 is unreleased (see [What's New](#whats-new)) |
| `@shorthand/core` | Compaction, CRDT memory, importance scoring, truth-ledger interop — a dependency, developed in [short-hand](https://github.com/johnnyclem/short-hand) | Not yet — published before `@smallchat/core` 1.0.0 |
| `@smallchat/react` | React hooks (`useToolDispatch`, `useToolStream`, `SmallchatProvider`) and `AppView` | Not yet — build from source |
| `@smallchat/nextjs` | Next.js App Router handlers (require an `authorize` hook) | Not yet — build from source |
| `@smallchat/testing` | `MockEmbedder`, `MockVectorIndex`, assertion helpers | Not yet — build from source |
| `smallchat-vscode` | VS Code syntax highlighting, manifest schema validation, snippets | Not yet — build from source |
| `@smallchat/playground` | Browser UI showing how the runtime resolves an intent | Private — run from source |

## Documentation

| Doc | What's inside |
|-----|---------------|
| [Quickstart](./QUICKSTART.md) | Zero to dispatching in 5 minutes |
| [Architecture](./ARCHITECTURE.md) | Full design document |
| [Reference](./docs/REFERENCE.md) | Runtime, dispatch, streaming, MCP server, CLI details |
| [Concept Mapping](./docs/REFERENCE.md#concept-mapping) | Smalltalk/Obj-C → smallchat translation table |
| [Migration Guide](./MIGRATION.md) | Upgrading from 0.5 to 1.0 |
| [LoomMCP integration](./packages/docs/docs/integrations/loom-mcp.md) | Pair smallchat with LoomMCP for semantic dispatch over symbol-level retrieval |
| [Changelog](./CHANGELOG.md) | Release history |

## Ecosystem

smallchat is part of a suite by the same author: [short-hand](https://github.com/johnnyclem/short-hand)
(`@shorthand/core`: compaction, CRDT memory, importance, truth-ledger interop — a dependency of
this package), [stenographer](https://github.com/johnnyclem/stenographer) (the truth ledger whose
Truth Format v2 `@shorthand/core` reads, and whose objections arrive over smallchat's
authenticated channel bridge), [smallchat-swift](https://github.com/johnnyclem/smallchat-swift)
(the Swift implementation, which runs this repo's `spec/` vectors) and
[polytician](https://github.com/johnnyclem/polytician). The integrations are file-format and
wire contracts (`spec/`, Truth Format v2, the channel `POST /event` body), not code dependencies,
except `@shorthand/core`. [`docs/ecosystem/`](./docs/ecosystem/executive-summary.md) holds a pre-1.0
evaluation of the ecosystem, with corrections at the top of each page.

## Development

```bash
npm test                        # ~1,400 tests: runtime, compiler, embeddings, MCP, transports, satellites
npm test --workspace=shorthand  # ~680 tests of the @shorthand/core mirror (CRDT properties, truth v2 fixtures)
npm run check:shorthand         # shorthand/ still matches the short-hand release it mirrors
npm run build && npm run test:pack   # pack, install and load the package as npm would publish it
npm run test:traces             # golden dispatch traces (after a build)
npm run dev                     # Watch mode
npm run lint                    # Type check
npm run docs:api                # Generate API reference
```

`shorthand/` is a byte-for-byte mirror of `@shorthand/core` (see `shorthand/README.md`); change
short-hand and re-run `SHORTHAND_DIR=../short-hand npm run sync:shorthand` instead of editing it.

## License

[MIT](./LICENSE)
