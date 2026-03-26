# Migration Guide: 0.1.0 → 0.2.0

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
import { SelectorNamespace } from 'smallchat';

const ns = new SelectorNamespace();
ns.register('search', 'provider-a');
ns.register('search', 'provider-b'); // throws SelectorShadowingError
```

**Intent Pinning** — Lock sensitive selectors against semantic collision:
```typescript
import { IntentPin } from 'smallchat';
// Pin critical selectors so adversarial intents can't re-bind them
```

**Semantic Rate Limiting** — Prevent vector flooding DoS:
```typescript
import { SemanticRateLimiter } from 'smallchat';

const limiter = new SemanticRateLimiter({ maxRequestsPerWindow: 100 });
```

**Container Sandboxing** — Run untrusted MCP servers in Docker isolation:
```typescript
import { spawnMcpProcess } from 'smallchat';

const proc = await spawnMcpProcess({ command: 'node', args: ['server.js'], sandbox: { type: 'container' } });
```

### 3. Worker Thread Embeddings (Non-Breaking)

For production workloads, move embedding and vector search off the main thread:

```typescript
import { createWorkerEmbedder, WorkerVectorIndex } from 'smallchat';

const embedder = await createWorkerEmbedder();
const index = new WorkerVectorIndex();
```

This is a drop-in replacement for `ONNXEmbedder` and `SqliteVectorIndex`.

### 4. Claude Code Channel Protocol (Additive)

Integrate smallchat with Claude Code's bidirectional channel:

```typescript
import { ClaudeCodeChannelAdapter, ChannelServer } from 'smallchat/channel';

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
smallchat init [directory] --template basic|mcp-server|agent

# Generate tool documentation
smallchat docs <artifact.json> -o TOOLS.md

# Interactive REPL
smallchat repl <artifact.json>
```

### 8. Package.json Exports (Tree-Shaking)

The main `smallchat` package now declares `"sideEffects": false` and uses proper ESM `exports` map with a `./channel` subpath export. This enables tree-shaking in bundlers like webpack, Rollup, and esbuild.

No code changes needed — your imports continue to work. Bundle sizes will decrease automatically.

### 9. SQLite Artifact Persistence (Additive)

Store compiled artifacts durably instead of as JSON files:

```typescript
import { SqliteArtifactStore } from 'smallchat';

const store = new SqliteArtifactStore('artifacts.db');
await store.save('my-toolkit', artifact);
const loaded = await store.load('my-toolkit');
```

## Need Help?

- Run `smallchat doctor` to check your setup
- Check the [examples/](./examples/) directory for working reference implementations
- File an issue at https://github.com/johnnyclem/smallchat/issues
