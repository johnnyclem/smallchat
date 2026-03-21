# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- **Examples** — Three complete use-case examples: GitHub Bot, Weather Agent, SQL Assistant
- **Tree-shaking support** — `sideEffects: false` and proper ESM exports for optimal bundling
- **TypeDoc configuration** — API reference generation via `npm run docs:api`
- **Migration guide** — Step-by-step guide for migrating from 0.1.0 to 1.0.0

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
