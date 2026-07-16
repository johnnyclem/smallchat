# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Semantic map: learned refinement resolution (Pillar 4b)
- **Deferring to the user is now a one-time cost, not a recurring tax.** The refinement protocol already turns a NONE-confidence dispatch into a dialogue ("I couldn't find an exact match. Did you mean one of these?") rather than guessing. What was missing was memory: every ambiguous intent re-asked the same question forever. The new `SemanticMap` (`src/runtime/semantic-map.ts`) records the user's choice when they resolve a refinement and reinforces it as a durable dispatch preference.
- **Exact fast-path.** A previously-disambiguated intent now resolves straight to the selector the user chose — before vector search, at the EXACT tier. The same question is never asked twice.
- **Similarity boost.** A *similar* future intent (cosine ≥ `similarityThreshold`, default 0.85) gets a confidence boost toward the learned selector, scaled by both similarity and how many times the mapping has been reinforced (saturating at `maxBoost`, default 0.30). A near-miss the user once clarified is lifted into a confident dispatch instead of deferring again.
- **New runtime API.** `runtime.resolveRefinement(originalIntent, choice)` takes the user's real-time selection, executes the chosen tool, *and* learns the mapping in one call. `choice` is a selector id or the refinement option object. `runtime.reinforceRefinement(intent, selectorId)` records without executing. `runtime.semanticMap` exposes the store for inspection; `SemanticMap.toJSON()` / `fromJSON()` persist learning across sessions (seed via `RuntimeOptions.semanticMap` / `semanticMapOptions`).
- **Auditable.** Refinement options now carry a `selectorId`, and both learned-resolution paths emit a `semantic_map` step in the resolution proof, so a learned influence on a dispatch is always visible and governable.
- **Consolidation.** Extracted the thrice-duplicated `cosineSimilarity` into `src/core/vector-math.ts` (now the single source of truth, used by the semantic map and semantic rate limiter).

### Changed — Sculpting the architecture around tool inference
- **Repositioning.** smallchat now leads with *tool inference* — deterministic, auditable, microsecond intent→tool resolution — as its durable thesis, and frames token reduction as a present-era *benefit* rather than the reason to exist. README, `ARCHITECTURE.md` (new "Two tiers" section), the `package.json` description, and the `src/index.ts` banner were rewritten accordingly.
- **Two-tier surface.** Added a dedicated `@smallchat/core/inference` entry point (`src/inference.ts`) that exports the durable inference engine alone, excluding the token-era optimization satellites. The optimization satellites (compaction, RTK, memex, CRDT, importance, dream) are now tagged `[satellite]` in the package barrel. No symbols were removed from the package root.

### Performance & correctness — inference core
- **Dispatch index wired.** Resolution previously re-scanned every registered tool class for every vector match (O(matches × classes)). The hot path now consults only the classes that declare the matched selector via a `selector → owning classes` index, so resolution cost no longer grows with unrelated providers. The index is rebuilt on `loadCategory`/`addOverload`/`swizzle`.
- **Tool summaries memoized.** The LLM-feature tool-summary list is computed once and cached on the dispatch context (invalidated on registry mutation) instead of being rebuilt up to four times per degraded dispatch.
- **Forwarding chain completed.** The forwarding chain's "LLM disambiguation" step was a `not yet implemented` stub. It now decomposes an unrecognized compound intent into sub-intents and dispatches each through the normal pipeline (guarded against reentrancy), making the `verify → decompose → refine → forward` fallback coherent end-to-end.
- **Confidence clamped.** Confidence derived from vector distance is clamped to `[0, 1]`, so a backend returning an over-orthogonal cosine distance can no longer produce a negative confidence that corrupts tier computation.

### Security
- **HTTP transport hardened.** `Access-Control-Allow-Origin: *` is no longer set by default on the MCP HTTP transport. Opt in with `serve --cors-origin <pattern>` (or set `corsOrigin` in `MCPServerConfig`). Same-origin clients (including the in-tree playground) are unaffected.
- **Request body size limit.** The `POST /mcp` endpoint now rejects bodies larger than 4 MB by default (configurable via `MCPServerConfig.maxBodyBytes` or `serve --max-body-bytes`), returning a JSON-RPC `Parse error` response and HTTP 413. Prevents memory-exhaustion DoS.
- **Spawned MCP server env isolation.** `spawnMcpProcess` (used by the MCP client / container sandbox) no longer forwards the full parent process environment to child MCP servers. A safe allowlist (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TZ`, `TERM`, `NODE_ENV`, `NODE_OPTIONS`, `SHELL`) is forwarded; everything else must be opted in via the per-server `env` map. Existing `env: { GITHUB_TOKEN: ... }` declarations in MCP configs continue to work. Pass `inheritEnv: true` to restore the old behaviour.
- **Prototype-pollution guard for manifest parsing.** All manifest and smallchat-config JSON files are now parsed through `safeJsonParse`, which rejects objects containing `__proto__`, `prototype`, or `constructor` keys at any depth.
- **Path-traversal guard in `smallchat.json`.** Local-manifest dependencies declared with relative paths that escape the config directory are now skipped with a warning rather than silently resolved.
- **Playground XSS fix.** `@smallchat/playground` now HTML-escapes every value rendered from a loaded toolkit (tool name, provider, selector, resolved selector, error message). A malicious manifest containing `<script>` in a tool name no longer executes in the developer's browser.
- **`.gitignore` hardened.** Common secret patterns (`.env*`, `*.key`, `*.pem`, etc.) and local SQLite write-ahead files are now ignored by default.

### Fixed
- **CLI `--version` reports 0.5.0.** Previously hardcoded to `0.1.0` in `src/cli/index.ts`; now read from `package.json`.
- **MCP server RTK compression path.** `formattedContent` in `tools/call` now keeps the MCP content-array shape after RTK compression instead of collapsing to a raw string (TypeScript build error).
- **Satellite package dependency name.** `@smallchat/react`, `@smallchat/nextjs`, `@smallchat/testing`, and `@smallchat/playground` now declare a peer dependency on `@smallchat/core ^0.5.0` (the actual published name) instead of the placeholder `smallchat ^0.1.0`. Their source `import` statements were updated accordingly. The example projects under `examples/` were similarly migrated.

### Changed
- **Docs.** README CLI table now lists all 14 registered commands (`setup`, `init`, `compile`, `serve`, `resolve`, `inspect`, `doctor`, `docs`, `repl`, `channel`, `dream`, `memex`, `app`, `rtk`). README's "274+ specs" claim updated to reflect the current ~1,250-spec suite. `MIGRATION.md` now carries a historical-document banner. Stale planning files (`PLAN-0.4.0.md`, `plan.md`) moved to `docs/archive/`.

### Dependencies
- `npm audit fix` applied — patches transitive `postcss` (XSS in stringifier) and `qs` (DoS) vulnerabilities pulled in via the docusaurus dev tree. No production dependency changes.

## [0.5.0] - 2026-04-30

### Added
- **LoomMCP integration guide** — New documentation page covering [LoomMCP](https://muhnehh.github.io/loom-mcp/), an MCP server that pairs naturally with smallchat: LoomMCP indexes codebases for exact-symbol retrieval (~97% token reduction) and smallchat dispatches its 17 MCP tools semantically, so an agent can hand smallchat a natural-language intent like "find all callers of loginUser" and have it route into the right loom_* tool with the right arguments.
- **Synchronized package versions** — All workspace packages (`@smallchat/core`, `@smallchat/react`, `@smallchat/nextjs`, `@smallchat/testing`, `@smallchat/playground`, `@smallchat/docs`, `@smallchat/examples`, `smallchat-vscode`) are now aligned at 0.5.0. Previous releases left the satellite packages at 0.3.0 while the core moved to 0.4.0.

### Changed
- **MCP server version** — `serverVersion` default in `MCPServer` and the version reported by the channel server, MCP client `clientInfo`, REPL banner, and compiled artifact metadata all bumped to 0.5.0.
- **Compiled artifact format version** — Artifact `version` field bumped from `0.3.0` to `0.5.0`. Existing 0.3.0/0.4.0 artifacts continue to load; recompile to refresh metadata.

### Documentation
- New `Integrations / LoomMCP` page in the Docusaurus site explaining how to compile LoomMCP's tools through smallchat.
- README "What's New" section refreshed to point at the 0.5.0 release notes.

## [0.4.0] - 2026-04-01

### Added
- **Confidence-tiered dispatch (Pillar 1)** — Every dispatch returns a confidence tier (EXACT/HIGH/MEDIUM/LOW/NONE) that determines runtime behavior. Tiers are actionable: MEDIUM triggers verification, LOW triggers decomposition, NONE triggers refinement.
- **Resolution proof** — Every dispatch includes a serializable `ResolutionProof` trace documenting exactly why a tool was chosen, with per-step timing.
- **Pre-flight verification (Pillar 2)** — `respondsToSelector:` gate between resolution and execution. Three progressive strategies: schema validation, keyword overlap, and optional LLM micro-check.
- **Intent decomposition (Pillar 3)** — `doesNotUnderstand:` handler for LOW-confidence dispatches. Complex intents are broken into sub-intents and dispatched individually with dependency resolution.
- **Refinement protocol (Pillar 4)** — `forwardInvocation:` dialogue for NONE-confidence dispatches. Returns structured `tool_refinement_needed` result type with options for the caller to narrow the intent.
- **Observation & adaptation (Pillar 5)** — KVO-inspired dispatch observer that tracks correction signals, schema rejections, and adapts per-tool-class thresholds in real-time.
- **Pluggable LLM interface** — `LLMClient` interface for verification, decomposition, and refinement. All LLM features degrade gracefully without a client.
- **Collision firewall** — Compiler now detects and warns on tool pairs in the 0.75–0.95 similarity zone (expanded from 0.89–0.95). Dispatches in this zone trigger MEDIUM-confidence verification.
- **`--strict` mode** — Compile flag that raises thresholds, enables verification on every dispatch, and treats ambiguity as error.
- **Negative examples** — Observer tracks known-bad intent+tool pairs and skips them during resolution.
- **Adaptive thresholds** — Per-tool-class threshold tuning based on observed correction signals and schema rejections.
- **MCP `tool_refinement_needed` result type** — New result type for MCP clients to present refinement options to users.

### Changed
- **Dispatch pipeline** — `resolveToolIMP` now branches on confidence tiers instead of binary match/fallback
- **Vector search threshold** — Lowered to 0.60 (from 0.75) to capture LOW-tier candidates for decomposition
- **DispatchContext** — Now accepts `DispatchConfig` with LLM client, strict mode, thresholds, and observer options
- **RuntimeOptions** — Extended with `llmClient`, `strict`, `thresholds`, and `observerOptions`
- **MCP server** — Version bumped to 0.4.0, tool call responses include confidence tier and refinement data
- **Version bump** — All packages and internal version strings updated to 0.4.0

## [0.3.0] - 2026-03-29

### Fixed
- **Build errors** — Fixed missing `async` on `hydrateRuntime` in artifact loader, added null safety for child process stdio handles in MCP client
- **Test fixes** — Added missing `await` on `SelectorTable.intern()` calls in intent pinning dispatch tests (5 tests)

### Changed
- **Version bump** — All packages and internal version strings updated to 0.3.0
- **Test suite** — 786 passing specs across 46 test files (up from 274+ in v0.2.0)

## [0.2.0] - 2026-03-26

### Added
- **Claude Code channel protocol** — Full bidirectional channel support for Claude Code integration with `ClaudeCodeChannelAdapter`, `ChannelServer`, and `SenderGate` (#24)
- **Container sandbox** — Docker-based isolation for MCP subprocess execution with `spawnMcpProcess` and `buildDockerArgs` (#39)
- **Worker thread embeddings** — `ONNXEmbedder` and `SqliteVectorIndex` now run in dedicated worker threads for non-blocking dispatch (#38)
- **SQLite artifact persistence** — `SqliteArtifactStore` for durable compiled artifact storage (#37)
- **Selector namespacing** — `SelectorNamespace` prevents selector shadowing across providers (#34)
- **Intent pinning** — Guard sensitive selectors against semantic collision attacks (#33)
- **Semantic rate limiting** — `SemanticRateLimiter` prevents vector flooding DoS with configurable thresholds (#35)
- **Strict signature validation** — Prevents type confusion attacks on overloaded selectors (#36)
- **CLI `init` command** — Scaffold new projects with `smallchat init` supporting `basic`, `mcp-server`, and `agent` templates
- **Fluent SDK API** — Chainable dispatch builder: `runtime.intent('search').withArgs({}).exec()`
- **TypeScript inference** — Full generic type inference for tool arguments through `DispatchBuilder<TArgs>`
- **`@smallchat/react` package** — React hooks: `useToolDispatch`, `useToolStream`, `useInferenceStream`, and `SmallchatProvider`
- **`@smallchat/nextjs` package** — Next.js App Router helpers: `createDispatchHandler`, `createStreamHandler`, `createToolListHandler`
- **CLI `docs` command** — Auto-generate Markdown documentation from compiled toolkit artifacts
- **CLI `repl` command** — Interactive shell for querying tool resolution with `:help`, `:providers`, `:tools`, `:stats` commands
- **VS Code extension** — Syntax highlighting for `.smallchat` files, JSON schema validation for manifests, autocomplete for tool/provider names, and snippets
- **`@smallchat/testing` package** — `MockEmbedder`, `MockVectorIndex`, `MockToolIMP`, `createMockSelector`, and assertion helpers
- **Playground web UI** — Browser-based resolution chain visualizer at `@smallchat/playground`
- **Improved error messages** — `UnrecognizedIntent` and `OverloadAmbiguityError` now include actionable fix suggestions and nearest-match hints
- **Examples** — Five complete use-case examples: GitHub Bot, Weather Agent, SQL Assistant, Channel Webhook, Full Pipeline
- **Tree-shaking support** — `sideEffects: false` and proper ESM exports for optimal bundling
- **TypeDoc configuration** — API reference generation via `npm run docs:api`
- **Comprehensive test suite** — 274+ Gherkin-style specs across 41 test files covering all modules (#31)

### Security
- **Intent pinning** — Immutable selectors for sensitive operations prevent adversarial re-binding
- **Selector namespacing** — Prevents cross-provider selector shadowing
- **Semantic rate limiting** — Configurable flood protection on vector embedding operations
- **Container sandboxing** — Docker isolation for untrusted MCP server processes
- **Type confusion prevention** — Strict signature validation on overloaded dispatch

## [0.1.0] - 2025-03-01

### Added
- Initial release
- Core runtime with Smalltalk/Objective-C inspired dispatch model
- `ToolRuntime`, `ToolClass`, `ToolProxy`, `SelectorTable`, `ResolutionCache`
- Overload resolution with type-aware dispatch
- SCObject hierarchy for parameter passing
- ONNX embedder with all-MiniLM-L6-v2 model support
- SQLite-vec and in-memory vector indices
- Tool compiler: PARSE → EMBED → LINK → OUTPUT pipeline
- MCP 2026 compliant server with JSON-RPC, SSE, OAuth 2.1
- MCP client with stdio introspection
- CLI commands: `compile`, `inspect`, `resolve`, `serve`, `doctor`
- Streaming dispatch with progressive inference support
- Cache versioning with provider/model/schema fingerprinting
- Protocol conformance and category system
- Forwarding chain with superclass traversal, broadened search, and LLM disambiguation stub
