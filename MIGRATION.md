# Migration Guide: 0.1.0 → 1.0.0

This guide covers all breaking changes and new patterns when upgrading from smallchat 0.1.0 to 1.0.0.

## Quick Summary

| Change | Action Required |
|--------|----------------|
| Fluent API added | Optional — existing `runtime.dispatch()` still works |
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

**After (1.0.0) — new option:**
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

### 2. Error Message Changes

Error messages now include actionable suggestions. If your code matches on error message text, update your patterns:

**Before:**
```
No tool available for: "unknown intent" (selector: unknown:intent)
```

**After:**
```
No tool available for: "unknown intent" (selector: unknown:intent)

Did you mean one of these?
  - "search:documents" (85% match)
  - "query:database" (72% match)

To fix this:
  1. Check that your manifest includes a tool for this intent
  2. Run "smallchat compile" to rebuild the dispatch table
  3. Run "smallchat resolve <artifact> <intent>" to debug resolution
  4. Lower the selector threshold if tools exist but similarity is too low
```

**Recommended:** Match on `error.name === 'UnrecognizedIntent'` instead of message text.

### 3. New Packages (Optional)

Install only what you need:

```bash
# React hooks
npm install @smallchat/react

# Next.js helpers
npm install @smallchat/nextjs

# Testing mocks
npm install --save-dev @smallchat/testing
```

### 4. New CLI Commands (Additive)

```bash
# Scaffold a new project
smallchat init [directory] --template basic|mcp-server|agent

# Generate tool documentation
smallchat docs <artifact.json> -o TOOLS.md

# Interactive REPL
smallchat repl <artifact.json>
```

### 5. Package.json Exports (Tree-Shaking)

The main `smallchat` package now declares `"sideEffects": false` and uses proper ESM `exports` map. This enables tree-shaking in bundlers like webpack, Rollup, and esbuild.

No code changes needed — your imports continue to work. Bundle sizes will decrease automatically.

### 6. TypeDoc API Reference

Generate API documentation:

```bash
npm run docs:api
```

Output appears in `docs/api/`.

## Need Help?

- Run `smallchat doctor` to check your setup
- Check the [examples/](./examples/) directory for working reference implementations
- File an issue at https://github.com/johnnyclem/smallchat/issues
