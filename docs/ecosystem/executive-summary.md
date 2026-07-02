# The Agent Stack: Executive Summary (SmallChat vantage point)

**Scope:** AgentVault, SmallChat, Stenographer, and Short-Hand — evaluated as a single ecosystem,
from inside the `johnnyclem/smallchat` repository.

**Audience:** stakeholders deciding whether/how to integrate these projects.

> **Sourcing note.** This session's GitHub access is scoped to `johnnyclem/smallchat` only.
> SmallChat (this repo, including its vendored `shorthand/` package) was evaluated directly from
> source. AgentVault's own ecosystem docs
> ([executive-summary](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/executive-summary.md),
> [engineering-guide](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/engineering-guide.md))
> were read directly (AgentVault is public). Stenographer was evaluated from its public GitHub
> README and repo metadata only — no source access. Short-Hand's *upstream* public repository
> (`johnnyclem/short-hand`) was spot-checked via its README for drift against the copy vendored in
> this repo, but its full source was not read — only the copy vendored here was. Treat any claim
> about Stenographer, or about upstream Short-Hand beyond what's vendored here, as
> README-derived, not verified.

## What each project is, in one line

| Project | One-line role | Language | License | Maturity |
|---|---|---|---|---|
| **AgentVault** | Deploys AI agents to Internet Computer canisters for persistent, 24/7, sovereign execution | TypeScript / Motoko | MIT | Active, per AgentVault's own docs: 508 tests, v1.0 docs *(README-derived, not verified from here)* |
| **SmallChat** (this repo) | Deterministic, in-process semantic tool dispatch — resolves a natural-language intent to the right tool via vector similarity, selector tables, and an auditable resolution proof | TypeScript (+ Swift port) | MIT | Public, `@smallchat/core` v0.5.0 on npm, ~1,250+ specs, no CI workflow configured in-repo |
| **Stenographer** | A passive "court reporter" that tails agent conversation logs and builds a searchable GraphRAG index (entities, relations, decisions) | TypeScript | — | Alpha (`0.1.0-alpha.2`), 0 stars, 10 commits *(README/repo-metadata only, not verified)* |
| **Short-Hand** | Progressive, LSM-tree-style compaction of conversation history into a token-budgeted context frame | TypeScript | MIT | Public, npm package, v0.1.0 in the copy vendored here |

## Key finding: from SmallChat's side, one bridge is fully built — and it's a different bridge than AgentVault's docs describe

AgentVault's ecosystem docs (read from source, since AgentVault is public) describe the
AgentVault ↔ SmallChat relationship as "vendor the pattern, not the package" and describe
Short-Hand ↔ SmallChat as **entirely aspirational** — a "language middleware" positioning taken
from Short-Hand's README with no code-level evidence either way.

From inside this repo, that second claim is **wrong, or at least badly out of date**: SmallChat
vendors Short-Hand directly.

- `package.json` declares `"@shorthand/core": "file:./shorthand"` — a local workspace package, not
  an aspiration.
- `shorthand/` is a full copy of Short-Hand's `compaction`, `crdt`, `importance`, and `embedding`
  modules, pulled into this repo by PR #58 ("Extract `@shorthand/core` package from compaction,
  CRDT, and importance modules").
- `src/index.ts` re-exports Short-Hand's compaction engine (`DefaultCompactor`, tombstone
  detection, recall testing, entropy/rate-distortion analysis) and CRDT primitives (`LWWRegister`,
  `ORSet`, `RGA`, `AgentMemory`, conflict detection) directly from `@shorthand/core/compaction` and
  `@shorthand/core/crdt`, under the package's own public API (`@smallchat/core/compaction`,
  `@smallchat/core/crdt`, and the package root).

So: **the Short-Hand ↔ SmallChat bridge exists, ships in the published npm package, and has done so
since v0.4.0.** This directly revises AgentVault's four-layer diagram, which drew Short-Hand
and SmallChat as adjacent-but-separate boxes connected by a "context frame" arrow — in reality, at
least two of Short-Hand's five subsystems (compaction, CRDT) already live *inside* SmallChat's
codebase and public API surface, not beside it.

## But the bridge is incomplete, and one part of it has silently drifted

The same PR that vendored compaction and CRDT claims, in its title, to have also extracted
**importance** scoring. That claim does not hold up:

- `@shorthand/core/importance` exists as a package export (`shorthand/package.json`), but
  `src/index.ts` does **not** re-export from it. It re-exports `ImportanceDetector` from a
  **separate, local copy** at `src/importance/`.
- That local copy has already **diverged** from the vendored one: `src/importance/types.ts`
  defines its own free-standing `ConversationMessage` interface, while
  `shorthand/src/importance/types.ts` imports `ConversationMessage` from Short-Hand's shared
  `types.ts` and re-exports a `normalizeTimestamp` helper the local fork lacks entirely.

This is a live instance of exactly the "duplication risk" AgentVault's docs warned about in the
abstract — except here it isn't hypothetical, it's an existing fork that has already drifted after
one extraction pass.

There is also a smaller, easy-to-fix metadata bug: the vendored `shorthand/package.json`
`repository.url` points at `https://github.com/johnnyclem/shorthand.git` (no hyphen), which
**does not exist** as a public repository — only `https://github.com/johnnyclem/short-hand`
(hyphenated) does. Anyone following that link from the vendored package metadata hits a 404.

## Stenographer: still zero references, confirmed from this side too

A case-insensitive search of this entire repository (source, tests, docs, `package.json`,
`package-lock.json`, examples) for `stenograph` turns up nothing. AgentVault's docs reported the
same from their side. Two independent zero-reference checks agree: **Stenographer is not wired to
anything in this ecosystem today**, on either end.

The closest analog inside SmallChat is the `dream` CLI command (`src/dream/`), which reads Claude
Code session logs and memory files to reprioritize/recompile the tool-dispatch artifact
(`log-analyzer.ts`, `memory-reader.ts`, `tool-prioritizer.ts`). It observes session history the way
Stenographer does, but for a narrow purpose (tool ranking, not entity/decision extraction) and with
no GraphRAG index, no MCP surface for querying decisions, and no relationship to Stenographer's code
or schemas. It should not be read as a partial Stenographer integration — it solves a different
problem.

## Why this matters

- **The four-layer thesis needs a footnote, not a rewrite.** SmallChat is still "the reflexes," but
  it is not layer-pure — it has directly absorbed working-memory-layer code (compaction, CRDT) into
  its own public API. Anyone integrating AgentVault ↔ SmallChat should know that pulling in
  `@smallchat/core` middle-tier features (`@smallchat/core/compaction`, `@smallchat/core/crdt`) also
  pulls in a slice of Short-Hand, whether or not that's an explicit design decision on the
  AgentVault side.
- **Duplication is not just a risk to plan around — it already happened.** The importance-scoring
  fork is evidence that "vendor now, reconcile later" degrades quickly without a sync process. If
  AgentVault ever vendors Stenographer or more of Short-Hand the way SmallChat vendored Short-Hand's
  compaction/CRDT modules, it should budget for keeping forks in sync, not assume a one-time import
  stays clean.
- **The "vendor vs. depend" question AgentVault asked about SmallChat has a concrete answer from
  this side.** SmallChat's real `ToolRuntime` (`src/runtime/runtime.ts`) requires an `Embedder` and
  a `VectorIndex` — semantic vector dispatch, backed by `onnxruntime-node` and `sqlite-vec` — plus a
  `SelectorTable`, `ResolutionCache` with rate limiting, and a `SelectorNamespace`. AgentVault's
  vendored `SmallChatBridge` has none of that: it's a deterministic selector-interning + LRU-cache
  + superclass-fallback dispatcher with no embeddings at all, purpose-built for Candid method
  signatures and a 64MB canister heap. These are genuinely different tools solving adjacent
  problems, not a thin fork of the same one. **Adopting the published `@smallchat/core` package
  as-is inside a canister is not just costly, as AgentVault's guide surmised — it would require
  bundling an ONNX runtime and a native SQLite vector extension into WASM, which is not currently
  feasible.** AgentVault's decision to keep its vendored pattern is confirmed correct from this side,
  for a stronger reason than originally stated.

## Recommendations

1. **Fix the importance-module fork now, before it drifts further.** Either re-export
   `ImportanceDetector` and friends from `@shorthand/core/importance` in `src/index.ts` (matching
   what was already done for compaction and CRDT), or delete the unused export path and document
   that importance scoring is intentionally out of scope for SmallChat. Leaving two diverging
   copies of the same detector under one repo is the worst of both options.
2. **Fix the `shorthand/package.json` repository URL** (`shorthand` → `short-hand`) so vendored
   package metadata points somewhere real.
3. **Do not treat AgentVault's four-layer diagram as settled.** If AgentVault's team pulls in
   `@smallchat/core`'s compaction or CRDT exports directly (rather than reimplementing them), they
   should know they are also pulling in Short-Hand by proxy, sourced from this repo's vendored copy
   rather than upstream `short-hand` directly — version skew between the two is possible and
   currently untracked.
4. **Stenographer integration is a clean-sheet decision, not a partial one.** Nothing here or on the
   AgentVault side is part-built. If it's pursued, `dream`'s log-reading infrastructure
   (`src/dream/log-analyzer.ts`, `memory-reader.ts`) is the nearest existing pattern in this repo
   for "read Claude Code session logs," though its output (tool-priority weights) and Stenographer's
   (GraphRAG entities/decisions) don't overlap enough to share code directly.
5. **Confirm AgentVault's Gap C conclusion and close the loop.** AgentVault's guide left the
   vendor-vs-depend question as a judgment call pending more information; this evaluation supplies
   the missing information (§ "Why this matters" above). Recommend AgentVault's engineering guide be
   updated to cite the concrete architectural mismatch (embeddings/vector index vs. Candid dispatch)
   rather than the more general "little clear benefit yet" framing it currently uses.

See [`engineering-guide.md`](./engineering-guide.md) for the technical detail behind these findings.
