---
title: compile
sidebar_label: compile
---

# `compile`

Reads tool manifests from a source directory, generates semantic embeddings, groups tools into dispatch classes, and emits a compiled artifact.

## Usage

```bash
npx @smallchat/core compile --source <dir> --output <file> [--watch]
```

## Options

| Option | Alias | Required | Description |
|--------|-------|----------|-------------|
| `--source <dir>` | `-s` | Yes | Directory containing `*-manifest.json` files |
| `--output <file>` | `-o` | Yes | Path to write the compiled artifact |
| `--watch` | `-w` | No | Watch the source directory for changes and recompile |

## Examples

### Basic compilation

```bash
npx @smallchat/core compile -s ./tools -o tools.json
```

Output:

```
Compiling tools...
  ✓ github-manifest.json     → 3 tools
  ✓ filesystem-manifest.json → 10 tools
  ✓ slack-manifest.json      → 2 tools
✓ 15 tools from 3 providers embedded.
Wrote tools.json (48 KB)
```

### Watch mode

In development, use `--watch` to automatically recompile when manifests change:

```bash
npx @smallchat/core compile -s ./tools -o tools.json --watch
```

Output:

```
Watching ./tools for changes...
[12:01:03] Compiled 15 tools. Wrote tools.json.
[12:03:17] github-manifest.json changed. Recompiling...
[12:03:18] Compiled 15 tools. Wrote tools.json.
```

The `--watch` flag pairs well with the hot-reload API in `ToolRuntime`:

```typescript
// In your application
await runtime.load('./tools.json');

// The compiler in watch mode rewrites tools.json → runtime detects and reloads
```

### Multiple source directories

Compile manifests from multiple directories by running separate `compile` invocations and merging, or by placing all manifests under a single root:

```bash
npx @smallchat/core compile -s ./tools -o tools.json
```

## Output format

The compiled artifact is a JSON file containing:

- **`version`** — artifact schema version
- **`fingerprint`** — SHA-256 hash of the combined manifest content
- **`providers`** — array of `ToolClass` descriptors
- **`selectors`** — the full `SelectorTable` with embeddings
- **`overloads`** — `OverloadTable` entries for tools sharing a selector

```json
{
  "version": "1",
  "fingerprint": "a3f2...",
  "providers": [
    {
      "id": "github",
      "name": "GitHub",
      "tools": [ ... ]
    }
  ],
  "selectors": [
    {
      "id": "sel_search_code",
      "canonical": "search for code",
      "embedding": [0.12, -0.04, ...]
    }
  ],
  "overloads": []
}
```

## Collision detection

When two tools from different providers produce the same canonical selector, the compiler emits a warning:

```
⚠ Selector collision: "search code" → [github.search_code, gitlab.search_code]
  Both tools will be registered as overloads.
```

Both tools are kept as overload entries under the shared selector. Dispatch resolves between them based on argument types.

## Selector deduplication

The compiler deduplicates selectors with cosine similarity ≥ 0.95 (default). Tools whose descriptions are nearly identical merge into one selector. You can tune this:

```bash
# Not yet a CLI flag — configure via ToolCompiler API
```

See [ToolCompiler API](../api/compiler) for programmatic configuration.
