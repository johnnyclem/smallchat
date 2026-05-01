# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
