# smallchat Reference

Detailed documentation for smallchat's runtime, dispatch system, CLI, and MCP server.

## Core Runtime

- **Selector Table** — semantic interning of tool intents (like `sel_registerName`)
- **Resolution Cache** — LRU cache with version tagging and automatic staleness detection
- **ToolClass** — provider grouping with dispatch tables, superclass chains, and overload support
- **ToolProxy** — lazy schema loading (like `NSProxy`)
- **resolve / dispatchById / dispatch** — choose a tool without running it; run exactly one tool by id; or both in one call (see below)
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

## Resolve, Dispatch by Id, and the Dispatch Policy

Resolution and execution are separate calls:

```typescript
// Choose a tool; nothing runs, nothing is cached or interned (learn: false).
const resolution = await runtime.resolve('close the stale issue');
// resolution.outcome: 'resolved' | 'needs-disambiguation' | 'unresolved'
// resolution.chosen:  'github/update_issue' (when resolved)
// resolution.candidates: [{ toolId, score, similarity, tier, source }, ...]

// Run exactly one tool by canonical id: O(1), no embedding.
const result = await runtime.dispatchById('github/update_issue', { number: 7, state: 'closed' },
  { resolutionDigest: resolution.proof.proofDigest });

// Convenience: resolve → policy → the same execution boundary.
const result2 = await runtime.dispatch('close the stale issue', { number: 7, state: 'closed' });
```

When resolution does not settle on one tool, `dispatch()` runs nothing and
returns `isError: true` with `metadata.outcome` (`needs-disambiguation` or
`unresolved`) and a `refinement` whose options carry `toolId`s for
`dispatchById`. MCP `tools/call` names tools exactly (by listed name or
canonical id) and never resolves semantically; an unknown or ambiguous name
is a `-32602` error.

The dispatch policy (`src/runtime/policy.ts`) is one function evaluated on
every path that can run a tool — pinned phrases, learned preferences, cache
hits, vector and overload candidates, protocol conformance, and each
sub-intent of a decomposition:

1. Dispatch by exact tool id is always allowed.
2. An `exact` intent pin accepts only its pinned phrases (the pin canonical
   or an alias, compared after Unicode NFKC, case and whitespace
   normalization — "do not transfer funds" is not "transfer funds"). An
   `elevated` pin needs its threshold on the cosine similarity of the
   intent's own embedding.
3. A destructive tool runs only by exact id, a pinned phrase, or EXACT
   similarity from the intent's own embedding — never from a cache hit, a
   learned preference or a boosted score. A tool is destructive when
   `annotations.destructiveHint` is true, or when it says
   `readOnlyHint: false` without a `destructiveHint` (MCP's default);
   `treatUnannotatedAsDestructive: true` extends this to tools with no
   annotations.
4. Below HIGH (MEDIUM/LOW), a tool runs only after an LLM verifier
   (`LLMClient.microCheck`) approves it for this intent. This is
   `requireLLMForSubHighDispatch`, on by default; without an `LLMClient`,
   sub-HIGH matches are `needs-disambiguation`. Alternates are verified
   with the same strategies as the best candidate.
5. Below LOW, nothing runs.

Configure it with `RuntimeOptions` (`requireLLMForSubHighDispatch`,
`strict`, `intentPins`, `treatUnannotatedAsDestructive`, `thresholds`,
`llmClient`) or, for `smallchat serve`, a `"policy"` block in
`smallchat.json`.

## Argument Validation

Every call is validated against the tool's `inputSchema` before it runs
(`src/core/argument-validator.ts`, Ajv): JSON Schema 2020-12 by default
(the MCP default dialect), 2019-09 and draft-07 when `$schema` says so.
Semantics are the schema's own: a closed schema (`additionalProperties:
false`) rejects unknown arguments; `required` ignores inherited and
`undefined` values; `NaN`/`Infinity` are not numbers. Types are not coerced
unless `argumentCoercion: 'primitives'` is set. A failure returns
`isError: true` with one readable line per problem, e.g.
`argument "days" must be integer, got string "-1"`, and the tool does not
run. A schema that cannot be compiled makes that tool uncallable (with the
compile error) rather than unchecked.

## Resolution Proofs and Call Digests

Every result carries `metadata.proof` (`src/core/proof.ts`): the outcome
and decision code, the chosen tool and the tool that actually ran, the full
candidate table (scores, similarities, tiers, sources, exclusions), the
thresholds and guards in force, the embedder fingerprint, the artifact
`contentHash`, and the steps taken. Raw arguments are never recorded; the
call is bound by its canonical call digest
(`sha256(UTF8("smallchat.call.v1") || 0x00 || toolId || 0x00 || JCS(args))`,
golden vectors in `spec/call-digest/vectors.json`). `proofDigest` covers the
whole proof except its timings, so the same decision made from the same
inputs has the same digest.

## Selector Table: Tools vs. Intents

`SelectorTable` interns two different things into the same table: compiled
tool selectors (from `ToolCompiler`) and runtime intent selectors (from
`SelectorTable.resolve()`, called on every dispatch). Intent selectors have
no owning `ToolClass` and are tagged `provenance: 'intent'` — they're
excluded from `selectorTable.all()` and from `searchTools()` by default, so
a user's own previously-resolved query never comes back as a phantom "tool"
or a refinement "did you mean?" suggestion. Pass `{ includeIntents: true }`
to `all()` for diagnostics. Intent selectors are also LRU-bounded
(`RuntimeOptions.maxIntentEntries`, default 500) since a long-lived process
resolves an unbounded number of distinct intents over its lifetime; compiled
tool selectors are never evicted.

## Embeddings & Vector Search

smallchat provides two embedding strategies and two vector index backends:

| Component | Implementation | Use case |
|-----------|---------------|----------|
| **HashEmbedder** (formerly `LocalEmbedder`) | Hash-based placeholder (same text → same vector; not semantic) | Development, testing, CI |
| **ONNXEmbedder** | all-MiniLM-L6-v2 via ONNX Runtime (384-dim) | Production semantic matching |
| **MemoryVectorIndex** | In-memory brute-force cosine similarity | Development, small tool sets |
| **SqliteVectorIndex** | sqlite-vec with persistent storage | Production, large tool sets |

The ONNX model ships with the package in `models/` (quantized, ~30MB).
Compiled artifacts record the embedder fingerprint (kind, model, model
SHA-256, dims, maxLength, pooling, normalize); every load path constructs
that embedder or refuses to load (see `spec/artifact/`).

> **Bundling in serverless / edge runtimes.** `ONNXEmbedder` falls back from
> `onnxruntime-node` to `onnxruntime-web` when the native addon isn't
> available (e.g. Vercel functions, which exclude it over the function-size
> limit). The web backend's node entry loads its WASM glue
> (`ort-wasm-*.mjs`) through a computed `import()` that most bundlers'
> file tracers can't follow, so it's easy to ship a function that's missing
> the glue next to the `.wasm` binaries. Since 1.0 this fails loudly: an
> artifact records its embedder fingerprint, and loading an ONNX-compiled
> artifact without a working ONNX embedder throws `EmbedderMismatchError`
> instead of degrading to hash vectors. If you bundle for a serverless/edge
> target, explicitly force-include `onnxruntime-web`'s `dist/ort-wasm*.mjs`
> and `dist/*.wasm` alongside your traced files.
>
> **Threshold calibration.** `DEFAULT_THRESHOLDS` (`exact .95 / high .85 /
> medium .75 / low .60`, `src/core/confidence.ts`) were tuned against a
> higher-contrast embedding space. In production against all-MiniLM-L6-v2
> over a CRUD-heavy, 70+-tool MCP toolkit, clear correct-tool paraphrases
> commonly scored only 0.60–0.74 — landing in the LOW tier for nearly every
> real match. If you see the same pattern, consider passing a lower/wider
> `RuntimeOptions.thresholds` tuned to your embedder and toolkit shape
> rather than assuming the defaults are miscalibrated dispatch.

## Compile Sources

The `compile` command accepts three types of input:

| Source | Example | What it does |
|--------|---------|--------------|
| **Directory** | `--source ./manifests` | Reads all `.json` manifest files from the directory |
| **MCP config file** | `--source ~/.mcp.json` | Parses `mcpServers` and connects to each server with the MCP SDK client: stdio entries are spawned, remote entries (`type: "http"` / `"sse"`, or a bare `url`) are reached over Streamable HTTP or legacy SSE. `${VAR}` / `${VAR:-default}` are expanded as Claude Code does, every `tools/list` page is read, and an entry that cannot be introspected is reported and skipped |
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

`npx @smallchat/core serve --source tools.toolkit.json` serves a compiled toolkit as one MCP server built on the official SDK (`@modelcontextprotocol/sdk`). It runs over stdio by default, or Streamable HTTP at `/mcp` with `--http`. It forwards every `tools/call`, by exact name, to the upstream MCP server that owns the tool, using the provider launch specs recorded at compile time. See [`serve`](../packages/docs/docs/cli/serve.md) for every option.

| Capability | Description |
|------------|-------------|
| **Tool names** | `<providerId>__<toolName>` (always `^[A-Za-z0-9_-]{1,128}$`, collision-free by construction). With `--provider <id>`, one provider's upstream names, verbatim, so OpenAPPA batteries keyed `mcp/<server>/<tool>` apply unchanged. |
| **tools/list** | Upstream `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, unchanged |
| **tools/call** | Exact listed name only. Arguments are validated against `inputSchema`, then the call is forwarded. The upstream result passes through (all content types, `structuredContent`, `isError`). Unknown names return an `isError` result listing close names. Nothing is resolved fuzzily. |
| **smallchat_resolve** | `{ intent, args? }` → proposal (`toolId`, `name`, `tier`, `candidates`, `proofDigest`). Never executes. |
| **Proof** | `_meta["dev.smallchat/resolution"]` on every result: tool id, what ran, decision, tier, canonical call digest, proof digest, artifact hash |
| **Upstreams** | SDK clients over stdio (env variables by name, values from serve's environment), Streamable HTTP or legacy SSE. Lazy connect, reconnect after exit, cancellation and progress forwarded. |
| **Resources / prompts** | `resources/list`, `read`, `templates/list`, `subscribe`/`unsubscribe` (per session, released on close), `prompts/list`, `get` |
| **HTTP guards** | Host allowlist (DNS rebinding), Origin allowlist (CSRF), bearer token required by default (generated into a 0600 file), JSON-only bodies, 4 MiB cap, session cap and idle expiry, optional rate limit |
| **Protocol** | Versions negotiated by the SDK: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 |
| **Audit** | `--audit-log <file>`: one JSON line per request with its real outcome, including HTTP rejections. Never records arguments. |

`smallchat doctor --mcp-source <artifact>` (stdio) or `--mcp <url>` (HTTP) runs the same conformance checks as the test suite.

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

## Security

0.2.0 introduces multiple layers of security hardening:

| Feature | Module | Purpose |
|---------|--------|---------|
| **Intent Pinning** | `src/core/intent-pin.ts` | Lock sensitive selectors against semantic collision |
| **Selector Namespacing** | `src/core/selector-namespace.ts` | Prevent cross-provider selector shadowing |
| **Semantic Rate Limiting** | `src/core/semantic-rate-limiter.ts` | Throttle vector embedding operations to prevent DoS |
| **Container Sandboxing** | `src/transport/container-sandbox.ts` | Docker isolation for untrusted MCP subprocesses; env values reach the container through the docker client's environment (`-e NAME`), never its command line |
| **Type Confusion Prevention** | `src/core/overload-table.ts` | Strict signature validation on overloaded dispatch |

## Claude Code Channel Protocol

The `channel` module provides bidirectional integration with Claude Code:

- **ClaudeCodeChannelAdapter** — Bridges the ToolRuntime to the Claude Code channel protocol
- **ChannelServer** — Hosts a channel endpoint for Claude Code to connect to
- **SenderGate** — Permission-based message filtering for channel events

```typescript
import { ClaudeCodeChannelAdapter, ChannelServer } from '@smallchat/core/channel';
```

## Worker Thread Offloading

For production workloads, `ONNXEmbedder` and `SqliteVectorIndex` can run in dedicated worker threads via `WorkerEmbedder` and `WorkerVectorIndex`, keeping the main thread free for dispatch:

```typescript
import { createWorkerEmbedder, WorkerVectorIndex } from '@smallchat/core';

const embedder = await createWorkerEmbedder();
const index = new WorkerVectorIndex();
const runtime = new ToolRuntime(index, embedder);
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `npx @smallchat/core compile` | Parse manifests, embed selectors, link dispatch tables → `.toolkit.json` |
| `npx @smallchat/core serve` | Serve a toolkit as one MCP server (stdio, or Streamable HTTP with `--http`) |
| `npx @smallchat/core resolve` | Test dispatch resolution against a compiled artifact |
| `npx @smallchat/core inspect` | Examine providers, selectors, and protocols in a compiled artifact |
| `npx @smallchat/core doctor` | Check environment: Node version, ONNX model availability, dependencies |
| `npx @smallchat/core init` | Scaffold a new project from `basic`, `mcp-server`, or `agent` templates |
| `npx @smallchat/core docs` | Generate Markdown documentation from a compiled artifact |
| `npx @smallchat/core repl` | Interactive shell for testing resolution with `:help`, `:tools`, `:stats` |

## Example Manifests

The `examples/` directory contains 32 MCP server manifest files for popular services, ready to use with `npx @smallchat/core compile`:

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

- **No built-in LLM verifier**: below HIGH confidence, intent dispatch needs an `LLMClient` you supply; without one those matches return `needs-disambiguation`.
- **JSON output**: Compiled artifacts are JSON. SQLite binary format planned for Phase 4.
