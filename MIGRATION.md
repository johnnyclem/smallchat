# Migration Guide: 0.5 → 1.0

1.0 is a major release; the sections below cover each breaking change.

## Compiled artifacts (format 1.0) and embedder identity

**Recompile every artifact.** 1.0 refuses 0.x `.toolkit.json` and `.db`
artifacts ("recompile with smallchat 1.0"). Run the same command you used
before:

```bash
smallchat compile --source ~/.mcp.json          # or ./manifests
smallchat compile --source ./manifests -f sqlite
```

**The artifact decides the embedder.** `serve`, `resolve`, `repl` and
`loadRuntime()` construct the embedder recorded in the artifact (ONNX by
default) and refuse a different one. If you passed `-e local` to `resolve`
or `repl`, drop it. In code, pass an embedder only if it matches:

```typescript
// 0.5
const { runtime, artifact } = await loadRuntime('tools.toolkit.json');
// artifact.dispatchTables[providerId][selector].toolName

// 1.0
const { runtime, artifact, embedder } = await loadRuntime('tools.toolkit.json');
const tool = artifact.tools['github/create_issue'];   // description, inputSchema, annotations…
```

**`LocalEmbedder` → `HashEmbedder`.** The old name still works (deprecated).
Use `ONNXEmbedder` (or just `loadRuntime`) for real semantic matching; the
hash embedder is for development and tests. Custom `Embedder`
implementations must declare a `fingerprint` (`kind: 'custom'`) to compile or
load artifacts, and must then be passed explicitly: `loadRuntime(path, { embedder })`.

**Near-duplicate tools are a compile error.** If `compile` reports
`N pair(s) of distinct tools embed at cosine >= 0.95`, either disambiguate
the tools (`selectorHint`, `aliases`, `exclude` compiler hints) or opt in
with `--allow-duplicates` / `"compiler": { "allowDuplicates": true }`.
Tools were previously merged silently (one of each pair was lost).
`CompilerOptions.deduplicationThreshold` is now `duplicateThreshold`
(the old name still works), and `CompilationResult.mergedCount` is gone.

**ONNX is required for the default compile.** If the model cannot be
loaded, `compile` fails instead of silently producing hash vectors. Fix the
install (`smallchat doctor`) or compile with `--embedder hash` explicitly.

**Reading artifacts yourself.** Use `readArtifact()` from
`@smallchat/core/artifact` (validates schema, consistency and content hash)
instead of `JSON.parse`. The format is specified in
`spec/artifact/artifact.v1.schema.json`. `SqliteArtifactStore.save()/load()`
now take/return `ArtifactV1`.

## Resolve vs. execute, argument validation and the dispatch policy

**Call tools by id when you know which tool you mean.** MCP hosts that pick
a tool from `tools/list` already do: `tools/call` now runs exactly the named
tool. In code, prefer `dispatchById` over `dispatch` whenever the tool is
known:

```typescript
// 0.5 — every call was semantic, even with an exact name
await runtime.dispatch('create_issue', { title: 'Bug' });

// 1.0 — exact: O(1), no embedding
await runtime.dispatchById('github/create_issue', { title: 'Bug' });

// 1.0 — propose, confirm, run
const r = await runtime.resolve('file a bug about the login page');
if (r.outcome === 'resolved') {
  await runtime.dispatchById(r.chosen!, args, { resolutionDigest: r.proof.proofDigest });
} else {
  // r.candidates / r.refinement.options carry tool ids to choose from
}
```

**Sub-HIGH matches no longer run without an LLM verifier.**
`requireLLMForSubHighDispatch` defaults to `true`. If MEDIUM/LOW matches
used to auto-run for you, either supply an `llmClient` with `microCheck`
(it is now asked whenever its approval authorizes the call), or opt out:
`new ToolRuntime(index, embedder, { requireLLMForSubHighDispatch: false })`.

**Unresolved dispatches are errors.** Check `result.isError` and
`result.metadata.outcome` (`'resolved' | 'needs-disambiguation' |
'unresolved' | 'invalid-arguments'`). The 0.x success-shaped "No match …
want me to search?" stub, `DispatchContext.forward()`, `FallbackStep` and
`FallbackChainResult` are gone; near misses are never executed.

**Destructive tools need an exact id, a pinned phrase or EXACT similarity.**
Tools annotated `destructiveHint: true` (or `readOnlyHint: false` without a
`destructiveHint`) return `needs-disambiguation` below EXACT; call them with
`dispatchById`. Set `treatUnannotatedAsDestructive: true` to treat tools
without annotations the same way.

**Arguments are validated.** Calls whose arguments do not match the tool's
`inputSchema` return `isError: true` with readable errors and do not run.
If a client sends numbers as strings, fix the client or set
`argumentCoercion: 'primitives'`. Custom `ToolIMP`s are validated against
`schemaLoader().inputSchema`; give them an accurate schema (or none).

**Intent pins match whole phrases.** `checkExact()` and `checkSimilarity()`
take the raw intent, compared with `normalizePinPhrase` (NFKC, lower case,
collapsed whitespace). A pin that relied on `canonicalize()` folding (e.g.
pin `delete:record` matching the intent "delete the record") needs the
phrase as an alias: `{ canonical: 'db.delete_record', policy: 'exact',
aliases: ['delete the record'] }`. Pass pins with
`RuntimeOptions.intentPins` (or a `"policy": { "pins": [...] }` block in
`smallchat.json` for `serve`).

**Proofs changed shape.** Read `proof.chosen`/`proof.ran` instead of
`proof.resolvedTool`, `proof.timings.totalMs` instead of `proof.elapsed`,
and `step.detail` instead of `step.input`/`step.output`. Compare decisions
with `proof.proofDigest` (timings excluded). `createProof`/`addProofStep`
now live in `core/proof.ts` (still exported from the package root and
`/inference`). `metadata.topCandidates[i].tool` is now `.toolId`.

**`resolveRefinement(intent, choice)` runs the chosen tool by id.** Pass the
option object (it carries `toolId`) or its `selectorId`.

## Retrieval: intent identity, determinism, feedback, rate limiting

**Intents are keyed by their full text.** The cache, the semantic map and
feedback use `intentKey(text)` (NFC, trimmed, whitespace collapsed, lower
case). Code that looked things up by `canonicalize(intent)` should pass the
intent text instead; `canonicalize()` is for display only:

```typescript
// 0.5
semanticMap.lookupExact(canonicalize(intent));
// 1.0
semanticMap.lookupExact(intent);          // normalized with intentKey()
```

**Persisted semantic maps.** `toJSON()` now writes version 2 (`intentKey`
instead of `intentCanonical`). `SemanticMap.fromJSON()` still reads version
1, but those entries only boost similar intents — they never answer an
exact lookup, because their keys conflated intents such as "delete the
logs" and "do not delete the logs". Re-teach important mappings (or let
`resolveRefinement` re-learn them) if you need the exact fast path.

**The selector table holds tools only.** `SelectorTable.resolve()` no longer
interns the intent, so drop `maxIntentEntries` and `all({ includeIntents })`,
and call `new SelectorTable(index, embedder, threshold?)` and
`intern(embedding, canonical)` without the removed parameters.

**SQLite vector indexes are rebuilt for cosine distance.** Opening an older
`.db` whose `vec_selectors` table has no `distance_metric` rebuilds the
table in place (ids and vectors are kept), so open it once with write
access. Thresholds now mean cosine similarity on every backend; if you
lowered thresholds to compensate for the old L2 scores, restore them.

**Negative examples come from explicit feedback.** If you relied on the
observer inferring corrections, either report them —

```typescript
runtime.feedback({ intent: 'search issues about login', toolId: 'github/search_prs', correct: false,
  expectedToolId: 'github/search_issues' });
```

— or opt back in with `observerOptions: { implicitCorrections: true }`.
`isNegativeExample(intent, toolId, principal?)` takes the canonical tool id
(not the bare tool name). `getAdaptedThresholds()`/`getAdaptiveThresholds()`
and the `correctionThreshold`/`thresholdBumpAmount` options are gone (they
never affected dispatch).

**Rate limiting is opt-in and per caller.** To keep vector-flooding
protection, pass `rateLimiter: { ... }` in `RuntimeOptions` and identify the
caller on each call (`dispatch(intent, args, { principal: sessionId })`,
`resolve(intent, { principal })`). Handle `outcome === 'throttled'`
(`result.metadata.retryAfterMs`) instead of catching `VectorFloodError`,
which is no longer thrown. `runtime.cache.rateLimiter`, `checkFloodGate()`,
`recordIntent()` and `getFloodingMetrics()` are removed; use
`SemanticRateLimiter.evaluate()` / `getMetrics(principal)` directly.

**Registry changes flush the cache.** `registerClass()` with an existing
name replaces that class; to remove one, call `unregisterClass(name)`.
Nothing to do unless you depended on the old class staying reachable.

**Decomposition depth is 2 by default** and at most 16 sub-intents run per
request: set `maxDecompositionDepth` / `maxSubDispatches` in
`RuntimeOptions` to change them.

**Custom transports and IMPs: cancellation and streaming.**
`ToolIMP.execute(args, options?)` and `ToolTransport.execute/
executeStream/executeInference(toolName, args, options?)` receive
`options.signal`; stop work when it aborts. A transport that streams
tokens must implement `supportsInference(toolName)` returning `true`
(otherwise streaming dispatch uses `executeStream`), and an
`executeInference` that gets a non-streamed reply should `return` it as a
`ToolResult` rather than yield nothing. `WorkerVectorIndex.search()` and
`size()` now return promises.

**Compiler hints.** Remove `priority` from compiler hints (compile warns;
it never changed dispatch) and `strict`/`priorityHints` from
`CompilerOptions`. smallchat.json `compiler` thresholds now apply to
`ToolCompiler.compile(manifests, projectManifest)`; constructor options
still win.

**ONNX vectors changed slightly.** Each text is embedded alone without
padding; recompile ONNX artifacts with 1.0 (required anyway).

## Replay, explain, decision log, doctor and the benchmark

**`smallchat doctor` checks your artifact.** When `./tools.toolkit.json`
exists (or `--artifact <path>` names one), doctor verifies it against its
embedder and index and exits 1 when a check fails — a pre-1.0 or tampered
artifact, an embedder that cannot be built or whose vectors do not
reproduce on this machine, or a vector index that does not hold the
artifact's selectors. Recompile with 1.0 (`smallchat compile`) to fix it;
near-duplicate tools and shared tool names are warnings only.

**`smallchat resolve` prints the runtime's decision.** The "✓ Unambiguous"
/ "? Ambiguous" lines (a 90% similarity rule of thumb the runtime never
used) are replaced by `Decision: <outcome> [→ <tool id>] (tier, decision
code)` and the proof digest — the same resolution `serve` and `dispatch`
make, under the nearest smallchat.json policy. Scripts that grepped for
"Unambiguous" should check for `Decision: resolved`, or use `smallchat
explain --json`.

**Golden traces instead of hand checks.** Record what each important
intent must resolve to in a JSONL file and run `smallchat replay
tools.toolkit.json traces/` in CI (exit 0 pass, 1 mismatch, 2 could not
run); see `examples/traces/` and `docs/REFERENCE.md`.

**Decision log (opt-in).** Set `RuntimeOptions.decisionLog` (a path, options
or a `DecisionLog`) or pass `--decision-log <file>` to `serve`. Lines are
written before a tool runs; a write failure throws `DecisionLogError` and
nothing runs, so put the file on a disk you can append to. One writer per
file.

**Benchmark.** The bench `smallchat` runner now runs the real runtime, so
its numbers dropped to what the runtime actually does (see
`docs/REFERENCE.md#benchmarks`); the `llm` runner is renamed
`simulated-llm`, `EmbeddingBaseline` takes the embedder to use, and
`bench/floors.json` holds the regression floors `npm test` enforces.

---

# Migration Guide: 0.1.0 → 0.2.0

> **Historical document.** This guide is preserved for users upgrading from the original 0.1.0 release. The current published version is 0.5.0; see the [Changelog](./CHANGELOG.md) for changes since 0.2.0. Newer migrations (if any are required) will be added to that file.

This guide covers all changes and new patterns when upgrading from smallchat 0.1.0 to 0.2.0.

## Quick Summary

| Change | Action Required |
|--------|----------------|
| Fluent API added | Optional — existing `runtime.dispatch()` still works |
| New security features | Optional — opt-in via `SelectorNamespace`, `SemanticRateLimiter`, intent pinning |
| Worker thread embeddings | Optional — use `WorkerEmbedder` / `WorkerVectorIndex` for non-blocking dispatch |
| Claude Code channel protocol | Optional — use `ClaudeCodeChannelAdapter` for Claude Code integration |
| New packages | Install separately if needed |
| Error messages improved | Update error handling if you match on message text |
| `sideEffects: false` | No action — improves bundle size automatically |
| New CLI commands | No action — additive only |

## Detailed Changes

### 1. Fluent Dispatch API (Non-Breaking)

The new `runtime.intent()` method provides a chainable builder pattern. The existing `runtime.dispatch()` method continues to work unchanged.

**Before (0.1.0):**
```typescript
const result = await runtime.dispatch('search documents', { query: 'hello' });
```

**After (0.2.0) — new option:**
```typescript
const result = await runtime.intent('search documents')
  .withArgs({ query: 'hello' })
  .withTimeout(5000)
  .exec();

// Or extract content directly:
const content = await runtime.intent<{ query: string }>('search')
  .withArgs({ query: 'hello' })
  .execContent<SearchResult>();

// Streaming:
for await (const event of runtime.intent('search').stream()) { ... }
```

### 2. Security Features (Opt-In)

0.2.0 introduces several security hardening features. All are opt-in and do not affect existing code.

**Selector Namespacing** — Prevent providers from shadowing each other's selectors:
```typescript
import { SelectorNamespace } from '@smallchat/core';

const ns = new SelectorNamespace();
ns.register('search', 'provider-a');
ns.register('search', 'provider-b'); // throws SelectorShadowingError
```

**Intent Pinning** — Lock sensitive selectors against semantic collision:
```typescript
import { IntentPin } from '@smallchat/core';
// Pin critical selectors so adversarial intents can't re-bind them
```

**Semantic Rate Limiting** — Prevent vector flooding DoS:
```typescript
import { SemanticRateLimiter } from '@smallchat/core';

const limiter = new SemanticRateLimiter({ maxRequestsPerWindow: 100 });
```

**Container Sandboxing** — Run untrusted MCP servers in Docker isolation:
```typescript
import { spawnMcpProcess } from '@smallchat/core';

const proc = await spawnMcpProcess({ command: 'node', args: ['server.js'], sandbox: { type: 'container' } });
```

### 3. Worker Thread Embeddings (Non-Breaking)

For production workloads, move embedding and vector search off the main thread:

```typescript
import { createWorkerEmbedder, WorkerVectorIndex } from '@smallchat/core';

const embedder = await createWorkerEmbedder();
const index = new WorkerVectorIndex();
```

This is a drop-in replacement for `ONNXEmbedder` and `SqliteVectorIndex`.

### 4. Claude Code Channel Protocol (Additive)

Integrate smallchat with Claude Code's bidirectional channel:

```typescript
import { ClaudeCodeChannelAdapter, ChannelServer } from '@smallchat/core/channel';

const adapter = new ClaudeCodeChannelAdapter(runtime);
const server = new ChannelServer(adapter, { port: 3002 });
```

### 5. Error Message Changes

Error messages now include actionable suggestions. If your code matches on error message text, update your patterns:

**Recommended:** Match on `error.name === 'UnrecognizedIntent'` instead of message text.

### 6. New Packages (Optional)

Install only what you need:

```bash
# React hooks
npm install @smallchat/react

# Next.js helpers
npm install @smallchat/nextjs

# Testing mocks
npm install --save-dev @smallchat/testing
```

### 7. New CLI Commands (Additive)

```bash
# Scaffold a new project
npx @smallchat/core init [directory] --template basic|mcp-server|agent

# Generate tool documentation
npx @smallchat/core docs <artifact.json> -o TOOLS.md

# Interactive REPL
npx @smallchat/core repl <artifact.json>
```

### 8. Package.json Exports (Tree-Shaking)

The main `@smallchat/core` package now declares `"sideEffects": false` and uses proper ESM `exports` map with a `./channel` subpath export. This enables tree-shaking in bundlers like webpack, Rollup, and esbuild.

No code changes needed — your imports continue to work. Bundle sizes will decrease automatically.

### 9. SQLite Artifact Persistence (Additive)

Store compiled artifacts durably instead of as JSON files:

```typescript
import { SqliteArtifactStore } from '@smallchat/core';

const store = new SqliteArtifactStore('artifacts.db');
await store.save('my-toolkit', artifact);
const loaded = await store.load('my-toolkit');
```

## Need Help?

- Run `npx @smallchat/core doctor` to check your setup
- Check the [examples/](./examples/) directory for working reference implementations
- File an issue at https://github.com/johnnyclem/smallchat/issues
