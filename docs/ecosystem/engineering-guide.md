# The Agent Stack: Engineering Guide (SmallChat vantage point)

Companion to [`executive-summary.md`](./executive-summary.md). Technical detail behind that
summary, gathered from source access to this repo (`johnnyclem/smallchat`) plus AgentVault's public
ecosystem docs and a README-level look at Stenographer and upstream Short-Hand.

> **Sourcing note.** Everything under "1. Component reference → SmallChat" and "2. What's actually
> wired up in this repo" is verified against source in this repository. AgentVault's component
> description and its own integration claims are taken from its public
> [`docs/ecosystem/engineering-guide.md`](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/engineering-guide.md)
> and [`executive-summary.md`](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/executive-summary.md),
> which this session fetched directly (AgentVault is public) — treat those as AgentVault's own
> source-verified claims about itself, not independently re-verified here. Stenographer's
> description is README/repo-metadata only (`github.com/johnnyclem/stenographer`, default branch
> `master`) — this session has no source access to it. Short-Hand's description below is verified
> against the copy vendored in this repo (`shorthand/`); its *upstream* public repository
> (`johnnyclem/short-hand`) was only spot-checked via README, not diffed line-by-line against the
> vendored copy — treat any claim about upstream drift as directional, not a verified diff.

## 1. Component reference

### SmallChat (this repo)

- **What it is:** a semantic tool-dispatch runtime. An agent expresses intent in natural language;
  SmallChat resolves it to a specific tool call deterministically and auditably, using vector
  similarity over a compiled tool registry rather than stuffing every tool schema into the LLM's
  context window.
- **Public entry points** (`package.json` `exports`): `.` (full package, includes satellites),
  `./inference` (durable core only — `src/inference.ts`), `./runtime`, `./compiler`, `./mcp`,
  `./embedding`, `./channel`, `./importance`, `./app`.
- **Core dispatch primitives** (`src/runtime/runtime.ts`): `ToolRuntime` composes a `SelectorTable`
  (vector-similarity tool matching over an injected `VectorIndex` + `Embedder`), a
  `ResolutionCache` (size-bounded, confidence-gated, rate-limited), and a `SelectorNamespace`. It
  requires a concrete `VectorIndex` and `Embedder` at construction — there is no schema-free,
  embedding-free dispatch mode.
- **Reference implementations shipped in-repo:** `MemoryVectorIndex`, `LocalEmbedder` (backed by
  `onnxruntime-node` + a quantized ONNX model in `models/`), plus `sqlite-vec`-backed persistent
  indexing for the compiled-artifact path.
- **CLI** (`src/cli/commands/`): `setup`, `init`, `compile`, `serve`, `resolve`, `inspect`,
  `doctor`, `docs`, `repl`, `channel`, `dream`, `memex`, `app`, `rtk` (14 commands, matches
  `README.md`'s CLI table).
- **Satellite subsystems** (tagged `[satellite]` in `src/index.ts`, re-exported from the package
  root but excluded from `@smallchat/core/inference`): compaction, CRDT, importance scoring, memex
  (knowledge pre-compilation), dream (memory-driven recompilation), RTK (output compression).
- **Maturity:** v0.5.0, workspaces for `packages/{react,nextjs,testing,playground,vscode-extension,
  examples,docs}` plus `shorthand/`, ~1,250+ specs per `README.md`/`CHANGELOG.md`. No
  `.github/workflows` directory exists in this repo — there is no in-repo CI configuration to point
  to as a maturity signal, whatever runs downstream of pushes is not visible from source.

### Short-Hand — as vendored in this repo (`shorthand/`)

- **What it is here:** not a sibling project referenced by name — a workspace package,
  `@shorthand/core` v0.1.0, installed via `"dependencies": { "@shorthand/core": "file:./shorthand" }`
  in this repo's root `package.json`.
- **Provenance:** introduced by PR #58, "Extract `@shorthand/core` package from compaction, CRDT,
  and importance modules" (see `git log --oneline -- shorthand`). Its own `package.json` still
  points `repository.url` at `https://github.com/johnnyclem/shorthand.git` — **that URL 404s**; the
  real public repo is `https://github.com/johnnyclem/short-hand` (hyphenated). This looks like a
  copy-paste slug error from the extraction, not evidence of a second, separate "shorthand" project.
- **What's actually inside** (`shorthand/src/`): `compaction/` (LSM-style five-level compactor,
  tombstone detection, recall testing, information-theoretic/entropy analysis, verification
  harness), `crdt/` (Lamport/vector clocks, `LWWRegister`, `ORSet`, `GSet`, `RGA`,
  `AgentMemory`/`MemoryMerge`/`ConflictDetector`), `importance/` (`ImportanceDetector`,
  reference-frequency and trajectory-discontinuity scoring, state-delta detection), `embedding/`
  (ONNX + SQLite vector index, worker-thread variants).
- **Upstream README claims** (from `johnnyclem/short-hand`, not verified against the vendored
  copy line-by-line): five-level LSM architecture, zero runtime dependencies, "active engrams"
  that re-interpret themselves at retrieval time, tiered interpretation (regex → local model → host
  LLM) with fallback. The vendored copy's `package.json` *does* declare runtime dependencies
  (`better-sqlite3`, `onnxruntime-node`, `sqlite-vec`) — so "zero runtime dependencies" is either a
  stale README claim upstream, describes a narrower subpackage than what's vendored here, or the
  vendored copy has diverged from what the README describes. Not resolved without upstream source
  access; flagged rather than asserted.

### Stenographer (README/metadata only — no source access from this session)

- Self-described as a passive MCP server that tails conversation logs (JSONL) and builds a
  GraphRAG index over entities, relations, and decisions, with a tombstone/supersession model for
  changed decisions. 13 MCP tools reported (`search_conversation`, `get_entities`, `get_relations`,
  `get_decisions`, etc.), plus a REST daemon mode on port 8787.
- Repo metadata (fetched directly from `github.com/johnnyclem/stenographer`): default branch
  `master`, 98.3% TypeScript / 1.7% JavaScript, 0 stars, 10 commits, version `0.1.0-alpha.2`, no
  repo description set. This is consistent with AgentVault's report of the same repo and adds no
  new information — both sessions are limited to the same public surface.

### AgentVault (README/public-docs only — no source access from this session)

- Per AgentVault's own public ecosystem docs: an ICP-canister deployment system for durable agent
  execution, with a vendored (from-scratch reimplementation, not an `@smallchat/core` dependency)
  SmallChat-pattern bridge in `src/orchestration/smallchat-{tools,bridge,compression,policy}.ts`,
  a `MemoryRepo` git-style versioned memory canister, and a `polytician-enricher.ts` that truncates
  enrichment context by raw character count. No independent verification was possible from this
  session; treat this paragraph as a summary of AgentVault's own claims about itself, not this
  repo's findings.

## 2. What's actually wired up in this repo today

Unlike AgentVault's docs (which found zero references to Stenographer or Short-Hand in AgentVault's
source), this repo has a real, shipping integration with one of the two:

| Integration | Status | Evidence |
|---|---|---|
| SmallChat → Short-Hand compaction | **Wired, shipped since v0.4.0** | `package.json` (`@shorthand/core: file:./shorthand`); `src/index.ts:304-358` re-exports `DefaultCompactor`, `runRecallTest`, `checkInvariants`, entropy/rate-distortion analysis, etc. from `@shorthand/core/compaction`, exposed publicly at `@smallchat/core/compaction` |
| SmallChat → Short-Hand CRDT | **Wired, shipped since v0.4.0** | `src/index.ts:434-479` re-exports `LWWRegister`, `ORSet`, `GSet`, `RGA`, `AgentMemory`, `ConflictDetector` from `@shorthand/core/crdt`, exposed at `@smallchat/core/crdt` |
| SmallChat → Short-Hand importance scoring | **Claimed wired, actually forked and drifting** | PR #58's title claims extraction "from compaction, CRDT, and importance modules," but `src/index.ts` exports `ImportanceDetector` from local `src/importance/index.ts`, not `@shorthand/core/importance`. `src/importance/types.ts` already differs from `shorthand/src/importance/types.ts` (self-contained `ConversationMessage` interface vs. one imported from Short-Hand's shared `types.ts`, plus a missing `normalizeTimestamp` re-export) |
| SmallChat ↔ Stenographer | **Zero references** | Repo-wide case-insensitive search for `stenograph` across source, tests, docs, `package.json`, `package-lock.json`, and `examples/` returns nothing |
| SmallChat ↔ AgentVault | **Zero references** | Same search for `agentvault` returns nothing |

The importance-module finding is the one piece of evidence in this whole evaluation (across both
the AgentVault-side docs and this one) of an ecosystem integration that was *attempted* and then
**silently degraded** rather than either fully completed or never started. It's worth more weight
than a simple gap, because it shows what happens to the other, not-yet-attempted integrations
(Stenographer↔anything) if they're done the same way without a follow-up reconciliation step.

## 3. Revising the four-layer diagram

AgentVault's engineering guide draws:

```
Stenographer (memory) → Short-Hand (compaction/retrieval) → LLM → SmallChat (dispatch) → AgentVault (body)
```

with each box a separate, arm's-length service connected by data-flow arrows. From this repo's
source, the SmallChat/Short-Hand boundary in that diagram is not arm's-length for two of Short-Hand's
five subsystems:

```
┌─────────────────────────────────────────────────────────┐
│  @smallchat/core (published npm package)                 │
│                                                           │
│   ┌───────────────────────────────────────────────────┐ │
│   │ Tier 1 — inference core (src/runtime, src/mcp,     │ │
│   │ src/compiler): ToolRuntime, SelectorTable,          │ │
│   │ ResolutionCache — vector-similarity dispatch        │ │
│   └───────────────────────────────────────────────────┘ │
│                                                           │
│   ┌───────────────────────────────────────────────────┐ │
│   │ Tier 2 — satellites (re-exported from package root) │ │
│   │                                                     │ │
│   │  compaction ◄──┐   crdt ◄──┐   importance            │ │
│   │  (from          │  (from    │   (LOCAL FORK —        │ │
│   │  @shorthand/    │  @shorthand/  drifted from          │ │
│   │  core/compaction)│ core/crdt)   @shorthand/core/      │ │
│   │                 │             importance, not         │ │
│   │                 │             re-exported from it)     │ │
│   └────────┬────────┴──────────────────────────────────┘ │
│            │                                              │
└────────────┼──────────────────────────────────────────────┘
             │ file:./shorthand
             ▼
   shorthand/ — vendored copy of Short-Hand's
   compaction, crdt, importance, embedding modules
   (package.json repository URL: broken — points to
    non-existent johnnyclem/shorthand, not
    johnnyclem/short-hand)
```

Practically: anyone downstream (including AgentVault, if it ever adopts `@smallchat/core` directly
per its own Gap C) who imports `@smallchat/core/compaction` or `@smallchat/core/crdt` is *also*
importing Short-Hand code, sourced from this repo's vendored fork rather than upstream `short-hand`
directly. That's a transitive dependency relationship AgentVault's diagram doesn't currently show at
all, since it draws Short-Hand and SmallChat as parallel, independently-adopted layers.

## 4. Answering AgentVault's Gap C from this side

AgentVault's guide left the "vendor `@smallchat/core` vs. keep the in-repo pattern" question as a
recommendation to keep vendoring, based on Candid/cycle-metering constraints inferred without
`@smallchat/core` source access. From here, the concrete mismatch is:

| | AgentVault's vendored `SmallChatBridge` | This repo's `ToolRuntime` |
|---|---|---|
| Dispatch mechanism | Selector interning + LRU resolution cache + superclass-fallback over a hand-built `ToolClass` hierarchy | Vector-similarity search over a `VectorIndex`, gated by a confidence-scored `ResolutionCache` |
| Required inputs | None beyond the Candid-derived tool tree | A concrete `Embedder` (ships as `LocalEmbedder`, backed by `onnxruntime-node` + a quantized ONNX model) and a `VectorIndex` (ships as `MemoryVectorIndex` or `sqlite-vec`-backed) |
| Runtime footprint | Pure TS, no native deps, tuned for a 64MB canister heap and cycle metering (per AgentVault's own docs) | Requires an ONNX runtime and, for persistence, a native SQLite extension — neither is WASM/canister-portable today |
| Fit for AgentVault's use case | Purpose-built | Would require bundling an ONNX runtime and a native vector-search extension inside a canister, which is not currently feasible |

This confirms AgentVault's "keep the vendored pattern" call, but for a harder architectural reason
than the guide states (it currently frames the decision as "little clear benefit yet" from a
re-platforming-cost perspective). Recommend the AgentVault-side doc be updated to cite this directly
if source-level confirmation is ever obtained on that side too.

## 5. Concrete file references in this repo (cross-project relevance)

| File | Relevance |
|---|---|
| `package.json` (`dependencies["@shorthand/core"]`) | The actual, shipping Short-Hand integration point |
| `shorthand/package.json` | Vendored Short-Hand manifest; has the broken `repository.url` |
| `src/index.ts:304-358` | Compaction re-exports from `@shorthand/core/compaction` |
| `src/index.ts:434-479` | CRDT re-exports from `@shorthand/core/crdt` |
| `src/importance/index.ts`, `src/importance/types.ts` | The drifted local fork of importance scoring — **not** sourced from `@shorthand/core/importance` despite the package exposing that entry point |
| `shorthand/src/importance/types.ts` | The vendored-but-unused-upstream version of the same module, for diffing against the local fork |
| `src/runtime/runtime.ts` | `ToolRuntime` — the real dispatch engine AgentVault would inherit if it ever depended on `@smallchat/core` directly |
| `src/dream/log-analyzer.ts`, `src/dream/memory-reader.ts`, `src/dream/tool-prioritizer.ts` | Nearest in-repo pattern for "read agent session logs and derive something from them," relevant if Stenographer integration is ever attempted from this side |
| `src/cli/commands/channel.ts`, `src/channel/channel-server.ts` | The existing Claude Code bridge (stdio JSON-RPC channel protocol) — the likely integration seam if Stenographer's `watch`/`daemon` modes were ever pointed at this repo's own session traffic |

## 6. Phased roadmap (from SmallChat's side)

1. **Phase 0 (do first, low risk, fixes an active bug):** Reconcile the importance-module fork —
   either re-export from `@shorthand/core/importance` in `src/index.ts` to match compaction/CRDT, or
   explicitly document why `src/importance/` is intentionally forked and stop advertising it as an
   extraction in the changelog. Fix `shorthand/package.json`'s `repository.url`.
2. **Phase 1 (optional, no urgency):** If upstream `short-hand` has evolved since this repo's
   vendored copy was cut (unknown from this session — no diff was possible without source access to
   upstream), evaluate re-syncing `shorthand/` against current upstream. Low priority since nothing
   here depends on upstream tracking it exactly.
3. **Phase 2 (only if Stenographer integration is pursued at all):** No existing scaffolding in this
   repo does GraphRAG-style entity/decision extraction. `src/dream/log-analyzer.ts` is the closest
   analog but solves a different problem (tool-priority ranking, not queryable decision history) and
   should not be assumed reusable without checking its actual parsing logic first.
4. **Not recommended:** vendoring or depending on Stenographer from SmallChat. Nothing in this
   repo's tool-dispatch responsibility needs a conversational GraphRAG index; that pairing (if it
   happens at all) belongs on the AgentVault/orchestration side, per AgentVault's own Gap B.

## 7. Risks and open questions

- **The importance-module drift is the concrete, present-tense version of the "duplication risk"
  both AgentVault's docs and this one describe abstractly elsewhere.** It should be fixed before more
  satellites are extracted the same way, or the next extraction will drift too.
- **Upstream `short-hand` vs. the vendored `shorthand/` copy may already have diverged** in ways this
  session couldn't check (no source access to `johnnyclem/short-hand`). The README-claimed "zero
  runtime dependencies" not matching the vendored copy's declared dependencies is a flag, not a
  confirmed contradiction — it could equally mean the README describes a narrower subpackage.
- **No CI configuration exists in this repo** (`.github/workflows` absent). Test count claims in
  `README.md`/`CHANGELOG.md` (~1,250+ specs) were not independently re-run in this session; treat as
  repo-stated, not re-verified here.
- **Stenographer remains entirely unverified from any angle available to either evaluation.** Both
  the AgentVault-side and this SmallChat-side evaluation are limited to its public README and repo
  metadata. Direct source access to `johnnyclem/stenographer` is needed before any integration code
  is written against its claimed MCP tool schemas.
