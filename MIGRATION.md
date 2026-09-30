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
