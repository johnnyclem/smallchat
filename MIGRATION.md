# Migration Guide: 0.5 → 1.0

1.0 is a major release; the sections below cover each breaking change.
The [CHANGELOG](./CHANGELOG.md) says why each one was made.

**Checklist**

1. Run Node.js 22 or newer ([toolchain](#toolchain-node-22-and-the-dependencies-that-need-it)).
2. Install `@smallchat/core@^1.0.0`; it depends on `@shorthand/core@^1.0.0`
   from npm. Import compaction, CRDT, importance and truth from
   `@shorthand/core`, and memex and dream from their subpaths
   ([root entry](#the-root-entry-is-the-inference-core-satellites-moved-to-subpaths)).
3. Recompile every artifact with 1.0 ([artifacts](#compiled-artifacts-format-10-and-embedder-identity)).
4. Treat `isError` dispatch results and `metadata.outcome` as the way
   "nothing ran" is reported, run tools by id with `dispatchById`, and
   expect below-HIGH matches to come back as `needs-disambiguation`
   without an LLM verifier ([dispatch](#resolve-vs-execute-argument-validation-and-the-dispatch-policy)).
5. MCP clients of `smallchat serve`: tools are `<providerId>__<toolName>`,
   stdio is the default, and `--http` needs a bearer token
   ([serve](#smallchat-serve-sdk-based-stdio-by-default-exact-aggregate-names)).
6. Channel bridge users: give it a credential
   ([channel](#smallchat-channel---http-bridge-credentials-and-identity)).
7. Replace configs that launch the unscoped `smallchat` npm name
   ([setup](#smallchat-setup-smallchat-rtk-setup-and-smallchat-init)).
8. Next.js, React, playground and dream users: see
   [satellites](#satellites-nextjs-react-playground-dream-and-memex).

## Toolchain: Node 22 and the dependencies that need it

`engines.node` is `>=22.0.0` (it was `>=20.0.0`); CI runs Node 22 and 24.
`commander` 15 and `better-sqlite3` 13 require Node 22. `better-sqlite3` 13
ships prebuilt Node-API binaries for Linux (glibc and musl), macOS and
Windows on x64 and arm64. A fresh `npm install` uses them directly; an
install from a lockfile (`npm ci`) runs npm's implicit `node-gyp rebuild`,
which compiles nothing when a prebuild matches but needs Python 3 and make
on the machine. On a slim image or an offline runner use
`npm ci --ignore-scripts` (the prebuilt binary still loads).
`@types/better-sqlite3` is `^9.6.0`.

## The root entry is the inference core; satellites moved to subpaths

`@smallchat/core` (the root entry) no longer re-exports the optimization
satellites. Imports of them from `'@smallchat/core'` fail to compile (and
are `undefined` at runtime); change the specifier:

| 0.5 import from `'@smallchat/core'` | 1.0 import |
|---|---|
| compaction (`DefaultCompactor`, `VerificationHarness`, `runRecallTest`, `checkInvariants`, entropy/rate-distortion helpers, …) | `@shorthand/core/compaction` |
| CRDT (`LamportClock`, `LWWRegister`, `ORSet`, `GSet`, `RGA`, `AgentMemory`, `MemoryMerge`, `ConflictDetector`, …) | `@shorthand/core/crdt` |
| importance (`ImportanceDetector`, … — already only on `@smallchat/core/importance`) | `@shorthand/core/importance` |
| truth (`parseWikiLines`, `selectCurrentTruth`, `TruthAwareCompactor`, `proposeInvariants`, …) | `@shorthand/core/truth` |
| memex (`memexCompile`, `memexIngest`, `memexResolveQuery`, `memexLint`, `memexListLintRules`, `memexCosineSimilarity`, `memexComputeTier`) | `@smallchat/core/memex` as `compile`, `ingest`, `resolveQuery`, `lint`, `listLintRules`, `cosineSimilarity`, `computeTier` (other names unchanged; `readKnowledgeSource(s)` → `readSource(s)`, types `MemexExtractedClaim`/`MemexExtractedEntity`/`MemexCompileOptions`/`MemexResolverOptions` → `ExtractedClaim`/`ExtractedEntity`/`CompileOptions`/`ResolverOptions`) |
| dream (`compileLatest`, `dream`, `analyzeSessionLog`, `loadArtifactManifest`, …) | `@smallchat/core/dream` (`loadArtifactManifest` → `loadManifest`) |

`@shorthand/core` is a dependency of `@smallchat/core`, so it is already
installed; add it to your own `package.json` when you import it directly.
`@smallchat/core/compaction`, `/crdt`, `/importance` and `/truth` exist in
1.x as `export *` re-exports of the same `@shorthand/core` subpaths, marked
`@deprecated` (removed in 2.0): they are a one-line migration, not an API of
their own. `@smallchat/core/memex` and `/dream` are `@experimental`: their
APIs may change in any 1.x release.

**Renamed compaction types.** `@shorthand/core` 1.0 merged smallchat's
vendored copy with the short-hand repository. In it, `CompactedState`,
`CompactionLevel`, `Compactor`, `Decision` and `VerificationResult` name the
LSM pipeline's types; the snapshot pipeline's types (what `DefaultCompactor`
returns, what 0.5 re-exported under those names) were renamed:

| 0.5 (`@smallchat/core`) | 1.0 (`@shorthand/core/compaction`) |
|---|---|
| `CompactedState` | `CompactedSnapshot` |
| `CompactionLevel` (`'L0'`–`'L3'`) | `SnapshotLevel` |
| `Compactor` | `SnapshotCompactor` |
| `Decision` | `SnapshotDecision` |
| `CompactionVerificationResult` | `SnapshotVerificationResult` |

The old names still exist on `@shorthand/core/compaction` (and the
deprecated `@smallchat/core/compaction`), but mean the LSM types, so code
that only renames the specifier compiles against different types. Rename
them. `Tombstone` gains a required `timestamp`; `applyTruthToCompactedState`
is `applyTruthToSnapshot` (old name kept, deprecated); `InvariantProposalLine`
is `UvProposalLine`.

**Behaviour changes in `@shorthand/core` 1.0** (all in its MIGRATION.md,
"Coming from smallchat's vendored copy"): the truth module reads and writes
Truth Format v2 (TRANSITION lines for status changes, `prevHash`/`hash`,
`sinceSeq`, the suite PROPOSAL envelope; the bare `shorthand-compaction`
proposal format is read-only), unknown or missing statuses fail closed
(history, never ground truth), an open UV contesting a TB is always
attached to it, and agents settle claims only together: a TB an agent
signs is ground truth only when its line carries a `quorum` of two or
more agent sessions that agreed from different angles (settling evidence
of two kinds, no item shared) within 15 minutes (otherwise it is
inadmissible, `'agent-without-quorum'`; a person may still sign alone, on
any evidence). `CONSUMPTION_RULES` now tells an agent that a verdict it
files with `resolve_uv` settles only that way or when a person rules:
update any prompt or snapshot that embeds the old text. The evidence
kinds `chat`, `ticket` and `doc` are known, and `evidenceClass(kind)` says
which kinds can settle a claim. OR-Set removes propagate and G-Set
keyless entries get replica-scoped ids (the CRDTs converge,
property-tested); the importance state-delta signal reads at most 16 KB
of prose per message.

`@smallchat/core@1.0.0` depends on `@shorthand/core@^1.0.0` from the
registry (0.x pointed at a `file:./shorthand` copy that only resolved
inside this repository, so a published install could not load). In this
repository `shorthand/` is an exact mirror of that release, written by
`scripts/sync-shorthand.mjs`; never edit it (see `shorthand/README.md`).

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
or `repl`, drop it. `repl` now prints each intent's resolution (outcome,
tier, chosen tool, candidates) instead of raw similarities, and its
`--threshold` option is gone: drop it. In code, pass an embedder only if
it matches:

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

**An alias phrase belongs to one tool.** Two tools that declare the same
`aliases` phrase (compared after NFKC, case and whitespace normalization),
in their manifests or through smallchat.json `toolHints`, are a compile
error (`SelectorConflictError` naming the phrase and both tools), even with
`--allow-duplicates`. In 0.x both alias selectors were kept and the phrase
tied between the tools. Keep the phrase on the tool it means, or make the
phrases specific (`run cargo tests`, `run npm tests`).

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
`result.metadata.outcome`, typed `DispatchOutcome`:

| outcome | ran a tool? |
|---|---|
| `'resolved'` | yes (its own failure is `isError: true` with this outcome) |
| `'needs-disambiguation'` | no: candidates exist, pick one by id |
| `'unresolved'` | no: nothing plausible matched (or an unknown id) |
| `'throttled'` | no: the opt-in rate limiter refused; see `retryAfterMs` |
| `'invalid-arguments'` | no: arguments failed the `inputSchema` |
| `'aborted'` | no: the signal fired before the tool started |
| `'not-dispatched'` | no: a decomposition sub-intent past `maxSubDispatches` |

Switch on every value, or at least treat unknown ones as "ran nothing".
The 0.x success-shaped "No match … want me to search?" stub,
`DispatchContext.forward()`, `FallbackStep` and `FallbackChainResult` are
gone; near misses are never executed.

**`execContent()` throws on errors.** `runtime.dispatch(intent).withArgs(a)
.execContent<T>()` used to return whatever `content` was, so an
unresolved intent came back as `{ error, outcome, candidates }` typed as
`T`. It now throws `DispatchError` (`outcome`, `candidates`, `result`) for
every `isError` result. Catch it, or use `.exec()` and check `isError`.

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
`smallchat.json` for `serve`). A pin covers every tool its selector
dispatches to — overload variants and every class that declares the
selector — so pinning a shared selector gates all of them.

**Learned preferences name a tool.** `resolveRefinement()` records the
chosen option's `toolId` with the selector, and the same intent later runs
that tool. Hosts that call `reinforceRefinement(intent, selectorId)`
directly should pass the tool id as a third argument when a selector has
overloads or several classes; without it the preference stands for the
selector's default tool, as before.

**Proofs changed shape.** Read `proof.chosen`/`proof.ran` instead of
`proof.resolvedTool`, `proof.timings.totalMs` instead of `proof.elapsed`,
and `step.detail` instead of `step.input`/`step.output`. Compare decisions
with `proof.proofDigest` (timings excluded). `createProof`/`addProofStep`
now live in `core/proof.ts` (still exported from the package root and
`/inference`). `metadata.topCandidates[i].tool` is now `.toolId`.

**`resolveRefinement(intent, choice)` runs the chosen tool by id.** Pass the
option object (it carries `toolId`) or its `selectorId`.

**Named-argument overload resolution changed.** `ToolClass.resolveSelectorWithNamedArgs()`
and `OverloadTable.resolveNamed()` treat an omitted optional parameter as
satisfied, match plain objects and arrays against `SCData` / `SCArray`
parameters, prefer a signature that declares every provided name, and
break ties as positional resolution does: higher arity, then an overload
you registered over a compiler-generated one, else `OverloadAmbiguityError`.
0.5 kept the first registered signature on a tie, so a direct call that
quietly got the first overload can now throw `OverloadAmbiguityError`: make
one signature more specific (or give it a discriminating parameter).
Dispatch never throws it; it leaves an ambiguous overload out of the
candidates (the proof records an `overload` step), so such an intent can
now resolve to another tool or come back `needs-disambiguation`.

**`canonicalJson()` and `callDigest()` refuse values that are not plain
JSON.** A `Date`, `Map`, `Set`, typed array or class instance anywhere in
the value throws a `TypeError`; 0.5 serialized it as `{}`, so different
values hashed alike. Convert first (`date.toISOString()`,
`Object.fromEntries(map)`, `Array.from(bytes)`, a plain object for a class
instance). Dispatch applies the same rule to arguments: a call whose
arguments are not plain JSON (after SCObject arguments are unwrapped) comes
back `outcome: 'invalid-arguments'` and runs nothing.

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
used) are replaced by `Outcome: <outcome> (tier …, decision …)`, the
chosen tool id with its serve name, the candidate table and the proof
digest — the same resolution `serve` and `dispatch` make, under the
nearest smallchat.json policy. Scripts that grepped for "Unambiguous"
should use `smallchat resolve --json` (`resolution.outcome`,
`resolution.chosen`) or `smallchat explain --json`.

**Golden traces instead of hand checks.** Record what each important
intent must resolve to in a JSONL file and run `smallchat replay
tools.toolkit.json traces/` in CI (exit 0 pass, 1 mismatch, 2 could not
run); see `examples/traces/` and `docs/REFERENCE.md`.

**Decision log (opt-in).** Set `RuntimeOptions.decisionLog` (a path, options
or a `DecisionLog`) or pass `--decision-log <file>` to `serve` (every
`tools/call` and `smallchat_resolve` is recorded), `resolve` or `explain`. Lines are
written before a tool runs; a write failure throws `DecisionLogError` and
nothing runs, so put the file on a disk you can append to. One writer per
file.

**Benchmark.** The bench `smallchat` runner now runs the real runtime, so
its numbers dropped to what the runtime actually does (see
`docs/REFERENCE.md#benchmarks`); the `llm` runner is renamed
`simulated-llm`, `EmbeddingBaseline` takes the embedder to use, and
`bench/floors.json` holds the regression floors `npm test` enforces.
## `smallchat serve`: SDK-based, stdio by default, exact aggregate names

**Configure hosts for stdio, or add `--http`.** `smallchat serve --source X`
now speaks MCP over stdio. This is what `mcpServers` entries launch:

```json
{ "mcpServers": { "smallchat": { "command": "smallchat", "args": ["serve", "--source", "/abs/tools.toolkit.json"] } } }
```

For HTTP, add `--http`. The endpoint is `http://127.0.0.1:3001/mcp`. It was
`POST /` or `/rpc` and `GET /sse`, and those paths, `/.well-known/mcp.json`,
`/health` and `POST /oauth/token` are gone. HTTP requires
`Authorization: Bearer <token>`, with the token in `~/.smallchat/serve-token`,
generated with mode 0600 on first start (`--token-file` to move it,
`--http-insecure` to opt out). Browsers need `--allowed-origin`. Binding
`0.0.0.0` needs `--allowed-host <name>`.

| 0.5 flag | 1.0 |
|---|---|
| `--auth` (OAuth 2.1) | bearer token by default; OAuth resource-server support is future work |
| `--db-path`, `--session-ttl <hours>` | sessions are in memory: `--max-sessions`, `--session-idle-timeout <minutes>` |
| `--cors-origin <o>` | `--allowed-origin <o...>` |
| `--audit` | `--audit-log <file>` (JSON lines) |
| `--rate-limit`, `--rate-limit-rpm`, `--rtk*`, `--max-body-bytes` | unchanged (HTTP only, except `--rtk`) |

**Recompile so serve knows how to start each server.** Execution uses the
provider launch specs recorded by `smallchat compile --source .mcp.json`
(or a manifest's `launch` / `endpoint`). Environment variables are recorded
by name: set their values in the environment `serve` runs in. A provider
without a launch spec lists its tools, but calls to them return an
`isError` result that says so.

**Call tools by their listed names.** Names are `<providerId>__<toolName>`
(e.g. `github__create_issue`). Calls by bare upstream name or canonical id
(`github/create_issue`) now return an `isError` result with close names
instead of running. To keep upstream names (e.g. for OpenAPPA batteries
keyed `mcp/<server>/<tool>`), serve each provider separately with
`--provider <id>`. Tools whose aggregate name would be invalid (dots,
more than 128 characters, or a provider id containing `__` or ending in `_`)
are only reachable with `--provider`.

**Intent dispatch is the `smallchat_resolve` tool.** It proposes a tool
and returns its `name`. The client then calls that name. Nothing executes
from an intent on the MCP surface any more. When you give `MCPServer` a
`runtimeOptions.rateLimiter`, a refused intent comes back as `outcome:
"throttled"` with `retryAfterMs`.

**Resource subscriptions are per session, by URI.** `resources/subscribe`
and `resources/unsubscribe` take `{ uri }`, as the MCP spec defines them;
0.5 answered `subscribe` with a `{ subscriptionId }` and required that id to
unsubscribe. Send `{ uri }` to both. Subscribing twice is a no-op,
notifications go only to the session that subscribed, and its
subscriptions end when the session closes.

**Read smallchat data from `_meta`.** Results no longer have top-level
`confidence`, `refinement` or `rtkSavedPct`. Read
`_meta["dev.smallchat/resolution"]` (`toolId`, `ran`, `tier`, `callDigest`,
`proofDigest`, …) and `_meta["dev.smallchat/rtk"].savedPct`. Upstream
results pass through unchanged (`structuredContent`, non-text content,
`isError`).

**Programmatic `MCPServer`.** Replace `new MCPServer({ port, host, sourcePath, dbPath, … }).start()` with:

```typescript
const server = new MCPServer({ sourcePath });
await server.startHttp({ port: 3001, host: '127.0.0.1', token });  // or: await server.startStdio()
```

`createHttpHandler(options)` needs `await server.load()` first and serves
`/mcp` only. `McpTool` drops `id`, `tags` and `version`. `title` and
`description` are optional, and `inputSchema` must be `{ type: 'object', … }`.
`OAuthManager`, `MCP_SCOPES`, `SessionStore`, `McpRouter`, `SessionManager`,
`SseBroker`, the `registry.ts` registries, `wire-format`, `MCP_ERROR` and
`formatContent` (use `toCallToolResult`) are removed. `AuditEntry.success` is
now `outcome: 'ok' | 'error' | 'rejected'`. `MCP_PROTOCOL_VERSIONS` lists the
versions the SDK negotiates. `registerTool` / `registerApp` executors now
receive only arguments that pass the tool's `inputSchema`; a call that
fails gets an `isError` result and the executor is not called, so declare
the schema your executor actually accepts.

**`loadRuntime()` returns `upstreams`.** MCP tools now execute on their
upstream servers. Call `await upstreams.close()` when you are done, or stdio
upstream processes keep your process alive.

**`smallchat resolve --execute` needs a HIGH/EXACT match.** Add `--force`
to run a weaker match. `--endpoint` is gone: the artifact's launch spec
decides where the tool runs.

**`doctor --mcp`** checks `http://127.0.0.1:3001/mcp` by default (it was
`http://127.0.0.1:3001`). Use `--mcp-source <artifact>` to check `serve`
over stdio.

## Outbound MCP clients, config introspection and the container sandbox

**`McpSseTransport` → `McpHttpTransport`.** The old name still works as a
deprecated alias. Both now speak real MCP: an initialize handshake, a
session, Streamable HTTP with a legacy SSE fallback, and per-call timeouts
that cancel the request upstream. A server that only accepted a bare
`tools/call` POST, with no handshake, is not an MCP server and will not
work. `executeStream` yields one final result.

```typescript
// 0.5
new McpSseTransport({ url, auth, reconnectDelayMs: 1000 });
// 1.0
new McpHttpTransport({ url, auth, transport: 'auto', timeoutMs: 30_000 });
```

**`MCPTransport` (`transportType: 'mcp'`)** now uses the same client, with
a 60 s default `timeoutMs`. Close its session with `await transport.close()`
or `clearTransports()`. It no longer yields token deltas from
`executeInference`.

**`McpStdioTransport`** drains the server's stderr (read it with
`stderrTail()`), restarts a server that failed to start on the next call
(after `restartBackoffMs`), and returns every `tools/list` page. Call
`await transport.dispose()` to stop the process.

**`smallchat compile` / `setup` with an MCP config.** Remote entries
(`"type": "http"` / `"sse"`, or a bare `"url"`) are now introspected.
Before, they made the whole command fail. An entry that cannot be
introspected is reported (`<id>: skipped — …` or `<id>: FAILED — …`) and
left out, and the others still compile, so check the output. `${VAR}`
references are expanded the way Claude Code expands them. The artifact
keeps the unexpanded templates (`"args": ["${HOME}/server.js"]`), so set
those variables in the environment `serve` runs in. Remote servers that
need headers (e.g. `Authorization`) are introspected with them, but the
artifact records only the URL: pass the headers to `UpstreamPool` /
`MCPServer` through `upstream.headers`.

**Container sandbox.** `buildDockerArgs()` now returns `-e NAME` without a
value. If you spawn docker yourself from `buildDockerArgs()`, put the values
in docker's environment, or use `buildMcpSpawnSpec()`, which returns
`{ command, args, env }` with both. The docker client no longer inherits
your whole environment, only the safe allowlist, `DOCKER_*` connection
settings and the server's variables.

**Behind a proxy.** Spawned servers no longer see `HTTPS_PROXY`,
`NO_PROXY` or `NODE_EXTRA_CA_CERTS` unless you set
`SMALLCHAT_FORWARD_PROXY_ENV=1` (or pass `forwardProxyEnv: true`).

## `HttpTransport` retries and uploads

**POST/PATCH are no longer retried by default.** If your API deduplicates
on an idempotency key, opt back in:

```typescript
new HttpTransport({
  baseUrl,
  retry: { maxRetries: 3, retryNonIdempotent: true },   // sends one Idempotency-Key per call
});
```

Or pass your own key in `input.headers['Idempotency-Key']`, which also
makes the call retryable. GET, HEAD, PUT, DELETE and OPTIONS are retried as
before. The retry loop now honours `retryableStatuses`.

**Error responses keep their body.** A 4xx/5xx result has the parsed body
in `content` and `isError: true`, with or without retries. Code that read
`metadata.body` after exhausted retries should read `content`.

**Streams in `FileUpload.content`** are read into memory, up to
`maxUploadBytes` (default 50 MiB, configurable on `HttpTransport`). If you
call `buildMultipartBody` yourself, first pass the files through
`await bufferFileUploads(files)`. Passing a stream directly now throws
instead of sending an empty file.

## `smallchat channel --http-bridge`: credentials and identity

**Move the secret off the command line.** `--http-bridge-secret <token>`
now fails with an error. Use one of these instead:

```json
{
  "mcpServers": {
    "webhook-channel": {
      "command": "npx",
      "args": ["-y", "@smallchat/core", "channel", "--name", "webhook", "--http-bridge"],
      "env": { "SMALLCHAT_CHANNEL_SECRET": "${SMALLCHAT_CHANNEL_SECRET}" }
    }
  }
}
```

or `--http-bridge-secret-file ~/.smallchat/channel-secret` (mode 0600). The
secret must be at least 16 characters. A bridge with no credential no
longer starts. Clients keep sending `X-Channel-Secret: <secret>` or
`Authorization: Bearer <secret>` to `POST /event`, so stenographer's
`--objection-channel` and the Swift messenger need no change.

**Sender gating uses the credential's identity.** The body `sender` field
is ignored. With only the shared secret, every request is the identity
`bridge` (rename it with `--http-bridge-secret-identity`). To gate
individual senders, give each one a token:

```bash
echo '{"alice@corp.example": "<long random token>"}' > ~/.smallchat/channel-tokens.json
chmod 600 ~/.smallchat/channel-tokens.json
smallchat channel --name ops --http-bridge \
  --http-bridge-tokens-file ~/.smallchat/channel-tokens.json \
  --sender-allowlist alice@corp.example
```

**Body `channel` is ignored.** Events always carry `--name`. Run one
channel server per channel name.

**Permission relay needs approvers.** Add `--permission-approvers
alice@corp.example` (programmatically: `permissionApprovers`). Verdicts
from anyone else, or from anyone when the list is empty, get `403`. Before,
a configured sender allowlist was enough. Read the approver from the
`permission-verdict` event's `approver` field.

**Requests must be JSON, from an allowed Host and Origin.** Send
`Content-Type: application/json`. Bridges bound to `0.0.0.0` need
`--http-bridge-allowed-host <name>`. Browser clients need
`httpBridgeCorsOrigin`. `meta.source` is dropped (the tag's `source` is
the channel name), so rename that key, e.g. to `origin`. `meta.sender` and
`meta.user` are dropped too: the notification Claude Code receives carries
`meta.sender` = the credential's identity. Put other people's names under
another key (e.g. `author`) if the event needs them.

**`/sse` permission requests go to approvers.** A non-approver's stream
still carries channel events and replies, but no `permission-request`
events. Watch for approvals with an approver's token.
`serializeChannelTag` takes the sender as a fourth argument instead of
reading `meta.sender`.

## `smallchat setup`, `smallchat rtk setup` and `smallchat init`

**`setup` keeps your servers.** Answering "yes" now adds a `smallchat`
entry next to your existing `mcpServers`. Removing duplicates is a
separate, optional step (`--disable-originals`): the originals move under
`smallchatDisabledMcpServers` in the same file. To undo either step, copy
the newest `<config>.smallchat-backup-<timestamp>` over the config. If an
earlier version replaced your servers, your original is in
`<config>.backup`, unless setup ran twice.

**Fix configs written by 0.5 setup.** Replace an entry like
`{"command": "npx", "args": ["smallchat", "serve", ...]}` with the one
setup now writes:

```json
{ "type": "stdio", "command": "npx", "args": ["-y", "@smallchat/core@1.0.0", "serve", "--source", "/abs/tools.toolkit.json"] }
```

The unscoped `smallchat` npm name is unregistered: anyone could publish a
package under it, and `npx` installs without prompting when an MCP host
starts it. Never launch the unscoped name; use `npx -y @smallchat/core@<version>`.

**Scripted setup:** `smallchat setup --no-interactive --config .mcp.json
--install [--disable-originals] [--embedder hash]`. Before, non-interactive
mode never wrote the config.

**`rtk setup`** stops with an error when `.claude/settings.json` is not
valid JSON. Fix the file and re-run. Re-running replaces the broken inline
hook that 0.5 installed with `.claude/hooks/smallchat-rtk-rewrite.mjs`.
Commit that file with `.claude/settings.json` if your team shares
settings. The hook rewrites `git status` to `rtk git status`, and your
permission rules then see the rewritten command, so an allow rule such as
`Bash(git status:*)` may also need `Bash(rtk git status:*)`.

**`init` runs `git init` and `npm install`** unless you pass `--no-git` /
`--no-install`.

**`init` templates register their tools.** Every template implements its
sample tools in `src/tools.ts` and registers them with
`registerLocalHandler` before loading them. `init` no longer writes
`smallchat.config.json`: nothing read it, so delete it from projects
`init` created (`smallchat.json` is the project file). In a project made
with the old `mcp-server` template, register each `local` tool's handler
before `new MCPServer(...)` (and move `tools/*.ts` under `src/`): `local`
tools run only in the process that registers them, so `smallchat serve`,
which forwards calls to upstream MCP servers, cannot run them either.

## Satellites: Next.js, React, playground, dream and memex

**`@smallchat/nextjs` handlers need an authorization decision.**
`createDispatchHandler()`, `createStreamHandler()` and
`createToolListHandler()` throw without one:

```typescript
// app/api/dispatch/route.ts
import { createDispatchHandler } from '@smallchat/nextjs';

export const POST = createDispatchHandler({
  // true: allow; false: 403; or return a Response (e.g. a 401) to send as-is
  authorize: async (request, call) => (await getSession(request))?.user != null,
});
```

Pass `unsafePublic: true` instead only for a route that should run tools
for anyone. `authorize` gets an unread copy of the request, so it may read
the body (for example to check a webhook signature). `call` is `{ kind: 'dispatch' | 'stream', intent, args }`, or
`{ kind: 'list' }` for the tool list. Requests over `maxBodyBytes` (64 KiB
by default) get 413; errors go to `onError` and the response body is a
generic `{ error: 'Dispatch failed.' }`. The handlers refuse a runtime
built with `requireLLMForSubHighDispatch: false` unless you also pass
`allowSubHighDispatch: true`; with the default runtime, intents below HIGH
confidence come back as `needs-disambiguation` results for your UI to
refine (or run with an LLM verifier configured). `createToolListHandler`'s
`GET(request)` now receives the request.

**`@smallchat/react`.** Calling `stream()` or `infer()` again, `cancel()`
or unmounting aborts the previous run (its tool is cancelled through the
dispatch signal) and drops its events; `useToolDispatch` and
`useAppDispatch` show only the latest call's result. If you relied on two
streams appending to one hook's state, use one hook per stream.
`AppView` is the host side of the MCP Apps protocol
(`@modelcontextprotocol/ext-apps`, a new dependency of `@smallchat/react`).
A view must connect with ext-apps' `App` (`app.connect()` sends
`ui/initialize`); a view that waits for 0.5's private
`{ type: 'mcp-ui/ready' }` handshake gets nothing. The view receives
`ui/notifications/tool-input` (pass the call's arguments as `toolInput`)
and one `CallToolResult` per `toolResult` (a string becomes a text block;
an object becomes a JSON text block plus `structuredContent`). To answer
the view's `tools/call`, pass `onCallTool={(name, args) => …}` returning a
`ToolResult` (for example from `runtime.dispatchById`); `onInteraction`
still reports tool calls and messages. To deliver `ui/resource-teardown`,
`await ref.current?.teardown()` before you unmount the view or change its
`componentUri`: a removed frame receives no messages. `AppView` is now a
`forwardRef` component, so render it as `<AppView … />` rather than calling
it as a function. It renders a `ui://` resource only from its HTML: pass
`html` (the text of the MCP `resources/read` result) or
`readResource={(uri) => …}`. An `http(s)` `componentUri` still loads as the
iframe `src`. The default `sandbox` is now `allow-scripts`; add
`allow-same-origin` back only for views you trust (with `allow-scripts` it
lets a same-origin view remove its sandbox).

**`@smallchat/playground`** is private (run it from source:
`node packages/playground/dist/index.js tools.toolkit.json [port]`). Its
`/api/resolve` returns the runtime's `{ outcome, tier, chosen, confidence,
reason, candidates, proofDigest }` instead of `{ resolvedSelector, matches }`,
and it listens on 127.0.0.1. Requests must name a loopback Host (pass
`allowedHosts` to `createPlaygroundServer(path, { allowedHosts })` or
`startPlayground` for other names), carry no Origin or the playground's own,
and POST `application/json`.

**`smallchat dream` no longer excludes tools on its own.** Tools the
heuristics would exclude are listed as "Proposed exclusions" (and in
`ToolPriorityHints.proposedExclusions`). To remove a tool, name it:

```jsonc
// smallchat.dream.json
{ "exclude": ["legacy_search"] }
```

or `smallchat dream --exclude legacy_search`; add
`"applyProposedExclusions": true` (`--apply-proposed-exclusions`) to apply
the proposals as 0.5 did. Boosts and demotions are advisory (recorded in
the artifact's `extensions.dream`, not applied to dispatch). Usage success
is the log's `is_error` flag only. Archives created by 0.5 are all labelled
manual; after upgrading, the next `dream --auto` runs label correctly, and
`--rollback` restores the newest archive labelled manual.
`archiveCurrentArtifact(projectDir, outputPath)` detects provenance when
you omit the third argument; `promoteArtifact` takes `isAutoGenerated`
(default `true`).

**Memex and dream are experimental** (`@smallchat/core/memex`,
`@smallchat/core/dream`): their APIs, file formats and heuristics may
change in any 1.x release. Memex no longer merges near-duplicate claims
that disagree (a negation on one side only, or each claim stating a
figure, such as a number, date or version, that the other does not), so a
knowledge base can keep both and report the contradiction; query results
carry `disputes`. Knowledge bases record the embedder they were compiled
with, and `memex query` uses it: drop `-e` from queries (it now only
asserts the kind), and recompile knowledge bases made before this
(`memex query` falls back to `-e`, default onnx, with a warning). `-e local`
still means the hash embedder; `-e hash` now does too, instead of ONNX.
`resolveQuery()` and `ingest()` throw `EmbedderMismatchError` when given a
different embedder than the knowledge base records.

## Developing smallchat: the `shorthand/` mirror

`shorthand/` is an exact copy of `@shorthand/core` from the short-hand
repository, written by `scripts/sync-shorthand.mjs`. Do not edit it:
change short-hand, then run `SHORTHAND_DIR=../short-hand npm run
sync:shorthand` (and `npm install --package-lock-only` if its dev
dependencies changed). `npm run check:shorthand` and the test suite fail
when the files differ from `shorthand/SOURCE`; with `SHORTHAND_DIR` set it
also compares them with that checkout, as CI does with short-hand at the
recorded commit (so push the short-hand commit before the mirror). `npm run build` now
cleans `dist/` before compiling.

---

# Migration Guide: 0.1.0 → 0.2.0

> **Historical document.** This guide is preserved for users upgrading from the original 0.1.0 release. For 0.5 → 1.0 see the top of this file; the [Changelog](./CHANGELOG.md) lists every release. (Only 0.1.0 was ever published to npm before 1.0.)

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
npx -y @smallchat/core init [directory] --template basic|mcp-server|agent

# Generate tool documentation
npx -y @smallchat/core docs <artifact.json> -o TOOLS.md

# Interactive REPL
npx -y @smallchat/core repl <artifact.json>
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

- Run `npx -y @smallchat/core doctor` to check your setup
- Check the [examples/](./examples/) directory for working reference implementations
- File an issue at https://github.com/johnnyclem/smallchat/issues
