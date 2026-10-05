# smallchat Reference

Detailed documentation for smallchat's runtime, dispatch system, CLI, and MCP server.

## Core Runtime

- **Selector Table** — the compiled tool selectors and their vector index (like `sel_registerName`); runtime intents are embedded on their own and never interned
- **Resolution Cache** — LRU cache keyed by the intent's full normalized text (`intentKey`), with version tagging and automatic staleness detection
- **ToolClass** — provider grouping with dispatch tables, superclass chains, and overload support
- **ToolProxy** — lazy schema loading (like `NSProxy`)
- **resolve / dispatchById / dispatch** — choose a tool without running it; run exactly one tool by id; or both in one call (see below)
- **smallchat_dispatchStream** — async generator streaming dispatch with real-time event feedback
- **ToolRuntime** — top-level runtime with swizzling, header generation, and inference streaming

## Streaming & Async Dispatch

smallchat supports three tiers of execution, with automatic fallback:

| Tier | Interface | Granularity | Use case |
|------|-----------|-------------|----------|
| 1 | `executeInference` | Token-level deltas | OpenAI/Anthropic SSE streams — used only when the IMP (for `ToolProxy`: its transport's `supportsInference()`) supports it |
| 2 | `executeStream` | Chunk-level results | Paginated or batched responses |
| 3 | `execute` | Single-shot | Simple tool calls |

An inference stream that yields no deltas falls back to the result it returns (a non-streamed upstream reply) or to tiers 2–3, so every resolved tool runs.

`smallchat_dispatchStream` yields a sequence of typed events:

```
resolving → tool-start → chunk* / inference-delta* → done
```

Cancellation: pass `{ signal }` (`dispatchStream(intent, args, { signal })`, `dispatch(intent, args, { signal })`, `dispatchById(id, args, { signal })`, `DispatchBuilder.withSignal()` / `withTimeout()`). The tool receives an `AbortSignal` (`execute(args, { signal })`) that fires when yours does or when you stop iterating a stream early; a signal that fired before execution means nothing runs (`outcome: 'aborted'`). Tools that ignore the signal keep running.

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
5. Tiebreaker: higher arity preferred, then developer-defined over semantic overloads; otherwise `OverloadAmbiguityError`

Named arguments (`{ query: 'x' }`) resolve the same way: omitted optional parameters are fine, plain JSON objects and arrays match `SCData` / `SCArray` slots, and signatures that declare every provided name are preferred.

The compiler can also report **semantic overload groups** — tools with similar embeddings but different argument signatures (`generateSemanticOverloads`, threshold default 0.82). Grouped tools are exempt from duplicate detection and listed in `CompilationResult.semanticOverloads`; 1.0 artifacts do not carry overload tables, so dispatch does not use them.

## Resolve, Dispatch by Id, and the Dispatch Policy

Resolution and execution are separate calls:

```typescript
// Choose a tool; nothing runs, nothing is cached (learn: false). Intents are never interned.
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
   (`LLMClient.microCheck`) or the shortlist judge (below) approves it for
   this intent. This is `requireLLMForSubHighDispatch`, on by default;
   without either, sub-HIGH matches are `needs-disambiguation`. Alternates
   are verified with the same strategies as the best candidate.
5. Below LOW, nothing runs.

Configure it with `RuntimeOptions` (`requireLLMForSubHighDispatch`,
`strict`, `intentPins`, `treatUnannotatedAsDestructive`, `thresholds`,
`llmClient`, `judge`) or, for `smallchat serve`, a `"policy"` block in
`smallchat.json` (which never configures a judge).

### Shortlist judge (optional)

`RuntimeOptions.judge` takes a `ShortlistJudge` (`src/core/judge.ts`; the
normative rules and vectors are `spec/judge/`): a tie-breaker that may only
pick among near-ties the ranking already produced. Unset (the default),
nothing below happens and nothing is sent anywhere.

- **When it is asked:** never for an EXACT or NONE winner; for a HIGH
  winner only when the runner-up is within the judge's `margin` (default
  0.05); for a MEDIUM or LOW winner always. Tiers are the configured
  thresholds.
- **What it is offered:** candidates within the margin of the winner that
  it could then run: the policy would allow them on its approval, and the
  deterministic verification the approval still gets would pass (the
  call's required parameters when they are known; keyword overlap wherever
  the candidate's tier is verified). At most `maxCandidates` (default 8),
  presented sorted by tool id, each with its description (one line, 240
  characters, labelled untrusted). A winner the policy refuses, or whose
  schema cannot be loaded, is not judged at all (the judge breaks ties, it
  does not overrule a refusal); nor is a HIGH winner left with no near-tie
  to choose from.
- **What its answer does:** approved (an offered id at probability ≥
  `acceptThreshold`, default 0.7) chooses that candidate, which still gets
  the deterministic verification strategies (the approval stands in for
  the LLM micro-check) and the policy — decision `judge-approved`;
  declined (abstain, an id not offered, a low probability) is
  `needs-disambiguation` with decision `judge-declined`; unavailable (an
  outage, a timeout, an HTTP error after retries, an answer outside the
  contract, an abort) reaches the outcome, tool and decision code it would
  without a judge, but the call waits up to the judge's `timeoutMs`
  (default 4000, enforced by the runtime whatever the judge does), its
  proof records the attempt (so its `proofDigest` differs from a run with
  no judge), and it is not cached.
- **What is recorded:** a `judge` proof step and `proof.judge` (name,
  model, verdict, tool id, probability, confidence, reason, margin,
  maxCandidates, request id); `proofDigest` covers only the name, model,
  verdict and tool id. Dispatch results carry `metadata.judge`. A
  resolution the judge took part in is never cached, nor is one resolved
  with a per-call `ResolveOptions.judge` on a runtime that has a judge.
- **Replay and explain never call it.** A decision-log line carries the
  verdict and replays with it; a golden-trace case may carry one
  (`"judge": {"verdict": "approved", "toolId": "…"}`); anything without one
  replays with no judge. A recorded verdict without a name or model is
  recorded as `recorded (unknown)`, never as the runtime's judge.
  `runtime.explain(intent)` resolves without the judge and says whether a
  live dispatch would ask it (`judge.wouldAsk`);
  `runtime.explain(resolution)` explains a recorded decision, verdict
  included. `ResolveOptions.judge` is `false` or a recorded verdict.

TypeSafe's Jev model is the experimental `@smallchat/core/jev`
(`JevJudge`): when asked, it sends the intent (after `redactIntent`) and the
offered tools' ids and descriptions to TypeSafe. Its API key is kept out of
every log, proof and serialization, it refuses to run in a browser unless
`dangerouslyAllowBrowser: true`, and it requires https.

### Determinism

Every similarity is quantized to 1e-4 before it is ranked or compared with
a threshold, and candidates with equal quantized scores are ordered by
canonical tool id (rules and golden vectors: `spec/ranking/`). The property
this gives: with the same artifact (`contentHash`), the same embedder
(fingerprint) and the same runtime state — registered classes, intent
pins, semantic map, feedback, resolution cache and options — the same
intent text yields the same outcome, candidate order and `proofDigest`.
Other intents the process resolved before do not enter into it. Not
covered: an LLM verifier's or decomposer's answers and a shortlist judge's
verdicts (inputs like any other; the property holds with no judge
configured, or replaying recorded verdicts), an opted-in rate limiter's
window, and cross-platform float drift larger than half a quantum. SQLite and in-memory indexes both report cosine
distance.

### Learning and feedback

- **Semantic map** — `resolveRefinement()` / `reinforceRefinement()` teach
  "this intent text → that tool"; the same `intentKey` later resolves at
  EXACT, and similar intents get a bounded boost.
- **Negative examples** — `runtime.feedback({ intent, toolId, correct:
  false, expectedToolId?, principal? })` keeps resolution from choosing that
  tool for that intent text (for one principal, when given); `correct: true`
  clears it. Implicit correction inference (a tool switch within 30 s) is
  off unless `observerOptions.implicitCorrections` is set, and invalid
  arguments never blacklist a tool.
- Registry changes (`registerClass` — which replaces a class of the same
  name — `unregisterClass`, `swizzle`, categories, overloads) and learning
  flush the resolution cache.

### Rate limiting (opt-in)

`RuntimeOptions.rateLimiter` enables the semantic rate limiter. It keeps a
sliding window per principal (`{ principal }` on `resolve`/`dispatch`;
default `"default"`) of novel intents — cache hits, pinned phrases and
learned exact intents are never embedded and never counted — and refuses
on volume (`maxNovelIntents`), gibberish (`maxCanonicalLength` /
`entropyFraction`) or incoherence (`similarityFloor`). A refused intent
resolves to `outcome: 'throttled'` with `retryAfterMs`; nothing is thrown.

### Decomposition limits

LOW-tier (or unmatched) intents may be split by `LLMClient.decompose` when
dispatching. Depth is bounded by `maxDecompositionDepth` (default 2),
sub-intents that restate the intent or one it came from are dropped, and at
most `maxSubDispatches` (default 16) sub-intents run per request.

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
whole proof except its timings and, when a shortlist judge was consulted,
only the judge's name, model, verdict and tool id (`spec/judge/` D4), so
the same decision made from the same inputs has the same digest.

## Replay, Explain and the Decision Log

Three tools make a decision checkable after the fact (`src/runtime/replay.ts`,
`src/runtime/explain.ts`, `src/runtime/decision-log.ts`):

- **`smallchat replay <artifact> <traces…>`** runs golden traces — JSONL or
  JSON cases `{intent, args?, expect: {toolId, tier?} | {outcome:
  "needs-disambiguation", candidates?} | {outcome: "unresolved"}}` — through
  `runtime.resolve()` with learning off (nothing executes, nothing is cached,
  the semantic map is read but never written; case order cannot change a
  result) and exits 0 when every case passes, 1 on a mismatch, 2 when it
  could not run. `examples/traces/` covers the example manifests; `npm run
  test:traces` compiles them and replays the traces, and CI runs it. The
  library API is `replayTraces(runtime, cases)` / `replayPaths(runtime, paths)`.
- **`smallchat explain <artifact> <intent>`** (`runtime.explain(intent)`)
  prints the candidate table — score, own-embedding similarity, tier,
  source, MCP hints, and the dispatch policy's verdict on running each
  candidate without the caller naming it — with the proof's steps and
  `proofDigest`.
- **Decision log** (`RuntimeOptions.decisionLog`, `serve --decision-log`,
  `resolve --decision-log`, `explain --decision-log`): an append-only JSONL
  file with one line per `resolve()`, intent dispatch and dispatch by id —
  `{schema: "smallchat.decision.v1", seq, ts, kind, intent?, intentDigest,
  principal, artifactHash, embedderFingerprint, outcome, decision, tier,
  toolId, execution, callDigest, proofDigest, prevHash, hash}`. Raw arguments
  are never written (the call digest binds them); `recordIntent: false` keeps
  only the intent's digest. `seq` starts at 1, `prevHash` is the previous
  line's `hash` (null on the first line), and `hash` = SHA-256 of the RFC 8785
  canonical JSON of the line without `hash` — the same chain shape as the
  suite's truth format. A dispatch's line is written before the tool runs;
  if it cannot be written the call throws `DecisionLogError` and nothing
  runs. `verifyDecisionLog(text)` finds the first edited, removed, reordered
  or inserted line; the chain shows the file is internally consistent, not
  that nobody rewrote all of it (keep the head hash elsewhere for that).
  `smallchat replay <artifact> decisions.jsonl` verifies the chain and
  re-resolves the logged intents: with the same artifact, embedder, policy
  and learned state, each outcome, tool id and tier is reproduced, and pure
  `resolve` lines reproduce their `proofDigest` exactly. A shortlist
  judge's verdict is in its line (`judge`) and answers in the judge's place
  on replay, so no judge is called. Decisions that rested on inputs the log
  does not hold (an LLM verifier's answer, a decomposition, the rate
  limiter's window) are reported as skipped. One writer per file.

## Selector Table: Tools Only

`SelectorTable` holds the compiled tool selectors (from `ToolCompiler` or an
artifact) and nothing else. A runtime intent is embedded on its own
(`intentSelector()`, keyed by `intentKey()`) and compared against the tool
selectors; it is never interned into the table. So an intent cannot become
a phantom "tool", shadow a real one in "did you mean?" suggestions, or change
how a later intent ranks, and a long-lived process does not accumulate
intent entries. `selectorTable.all()` and `searchTools()` return tool
selectors only. (0.x interned intents, tagged them `provenance: 'intent'`,
and bounded them with `RuntimeOptions.maxIntentEntries`; that option and
`all({ includeIntents })` are removed.)

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

`npx -y @smallchat/core serve --source tools.toolkit.json` serves a compiled toolkit as one MCP server built on the official SDK (`@modelcontextprotocol/sdk`). It runs over stdio by default, or Streamable HTTP at `/mcp` with `--http`. It forwards every `tools/call`, by exact name, to the upstream MCP server that owns the tool, using the provider launch specs recorded at compile time. See [`serve`](../packages/docs/docs/cli/serve.md) for every option.

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
| **Decision log** | `--decision-log <file>`: one hash-chained line per `tools/call` and `smallchat_resolve`, written before anything runs (see [Replay, Explain and the Decision Log](#replay-explain-and-the-decision-log)). Never records arguments. |

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
| **Semantic Rate Limiting** | `src/core/semantic-rate-limiter.ts` | Opt-in, per-principal throttling of novel-intent embedding (vector-flooding DoS) |
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
import { createWorkerEmbedder, WorkerVectorIndex, ToolRuntime } from '@smallchat/core';

// One worker hosts both the ONNX embedder and the sqlite-vec index.
const { bridge, embedder } = createWorkerEmbedder({ vectorIndexDbPath: './vectors.db' });
const index = new WorkerVectorIndex(bridge);
const runtime = new ToolRuntime(index, embedder);
// ... register tools, dispatch as usual; when done:
await bridge.terminate();
```

`WorkerVectorIndex.search()` and `size()` return promises (the `VectorIndex` interface allows it); the runtime awaits them.

## CLI Reference

| Command | Description |
|---------|-------------|
| `npx -y @smallchat/core compile` | Parse manifests, embed selectors, link dispatch tables → `.toolkit.json` |
| `npx -y @smallchat/core serve` | Serve a toolkit as one MCP server (stdio, or Streamable HTTP with `--http`); `--decision-log` appends every resolution and call to a hash-chained JSONL log |
| `npx -y @smallchat/core resolve` | Test dispatch resolution against a compiled artifact; prints the runtime's decision and proof digest |
| `npx -y @smallchat/core explain` | Candidate table, tiers, policy verdicts and proof digest for one intent |
| `npx -y @smallchat/core replay` | Check golden traces or a decision log against an artifact (exit 0 pass / 1 mismatch / 2 could not run) |
| `npx -y @smallchat/core inspect` | Examine providers, selectors, and protocols in a compiled artifact |
| `npx -y @smallchat/core doctor` | Check environment (ONNX model, dependencies) and, with `--artifact` (default `./tools.toolkit.json` when present), artifact ↔ embedder ↔ index compatibility and near-duplicate tools; `--mcp <url>` / `--mcp-source <artifact>` run the MCP conformance checks |
| `npx -y @smallchat/core init` | Scaffold a new project from `basic`, `mcp-server`, or `agent` templates |
| `npx -y @smallchat/core docs` | Generate Markdown documentation from a compiled artifact |
| `npx -y @smallchat/core repl` | Interactive shell for testing resolution with `:help`, `:tools`, `:stats` |

## Example Manifests

The `examples/` directory contains 32 MCP server manifest files for popular services, ready to use with `npx -y @smallchat/core compile`:

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

`bench/` measures intent → tool selection on a labeled set:
`bench/dataset.json` (111 queries, each with an expected tool and
acceptable alternatives) over `bench/tools.json` (45 tools from 21
providers; several providers share an operation such as `weather.get`).

The `smallchat` runner is the real runtime: the catalog is compiled in-process
with the default embedder and every query goes through `runtime.resolve()`
with learning off (`bench/runners/smallchat.ts`). It is scored two ways:

- **Ranking** — top-1 / top-3: is the expected (or an acceptable) tool the
  best, or among the three best, tools the runtime offers (its candidates,
  or its refinement options when nothing reaches the LOW threshold)?
- **Decisions** — what the runtime would do on its own: resolve to the right
  tool, resolve to a wrong one, ask for disambiguation, or find nothing.

Measured 2026-10-01 on linux x64, Node 22, ONNX all-MiniLM-L6-v2, default
thresholds and policy, no LLM verifier:

| | smallchat runtime | embedding-only (same ONNX embedder) | keyword baseline |
|---|---|---|---|
| top-1 | 61/111 (55%) | 74/111 (67%) | 71/111 (64%) |
| top-3 | 75/111 (68%) | 101/111 (91%) | 91/111 (82%) |
| resolved to the right tool | 0 | — | — |
| resolved to a wrong tool | 0 | — | — |
| needs-disambiguation | 5 (4.5%) | — | — |
| unresolved | 106 (95.5%) | — | — |

On this set, with default thresholds and no LLM verifier, the runtime ran no
tool on its own — right or wrong: query-to-description similarities mostly
fall below LOW (0.60). Its ranking is below plain nearest-description search
with the same embedder on this set. The `simulated-llm` runner is a
heuristic stand-in (no model is called); its numbers say nothing about any
LLM. `npm test` fails if the runtime falls below the floors in
`bench/floors.json` (top-1 0.52, top-3 0.64, wrong-tool rate above 0.02);
`npx tsx bench/run.ts` prints the full report.

## Concept Mapping

| Smalltalk / Obj-C | smallchat |
|---|---|
| Object | ToolProvider (MCP server, API, local function) |
| Class | ToolClass (group of related tools) |
| SEL | ToolSelector (semantic fingerprint of intent) |
| IMP | ToolIMP (concrete implementation) |
| Method = SEL + IMP | ToolMethod |
| Message send | `runtime.dispatch(intent, args)` (or `resolve` + `dispatchById`) |
| Message stream | `runtime.dispatchStream(intent, args)` |
| Method cache | Resolution cache (intent → resolved tool, version-tagged) |
| Protocol | ToolProtocol (capability interface) |
| Category | ToolCategory (capability extension) |
| `respondsToSelector:` | `canHandle(selector)` |
| `forwardInvocation:` | Refinement: when no tool is chosen, the outcome is `needs-disambiguation` / `unresolved` with options to pick by tool id (nothing is forwarded or executed on a guess) |
| NSProxy | ToolProxy (lazy schema loading) |
| NSObject | SCObject (typed parameter hierarchy) |

## Current Limitations

- **No built-in LLM verifier**: below HIGH confidence, intent dispatch needs an `LLMClient` or a shortlist judge you supply (TypeSafe's is the experimental `@smallchat/core/jev`); without either those matches return `needs-disambiguation`.
- **Default thresholds refuse most natural-language queries** with all-MiniLM-L6-v2 (see Benchmarks); per-toolkit calibration is not built yet.
- **JSON output**: Compiled artifacts are JSON. SQLite binary format planned for Phase 4.
