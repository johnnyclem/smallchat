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
| `--source <path>` | `-s` | No | Directory of `*-manifest.json` files or an MCP config file (auto-detects when omitted) |
| `--output <file>` | `-o` | No | Path to write the compiled artifact (default `tools.toolkit.json`) |
| `--embedder <type>` | `-e` | No | `onnx` (default) or `hash` |
| `--format <type>` | `-f` | No | `json` (default) or `sqlite` (writes `.db`) |
| `--allow-duplicates` | | No | Keep near-duplicate tools as a warning instead of an error |
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

The runtime does not watch the file. To pick up a recompiled artifact, load
it again and swap the runtime (or re-register its classes):

```typescript
import { watch } from 'node:fs';
import { loadRuntime } from '@smallchat/core';

let { runtime, upstreams } = await loadRuntime('./tools.json');
watch('./tools.json', async () => {
  const next = await loadRuntime('./tools.json');
  await upstreams.close();
  ({ runtime, upstreams } = next);
});
```

### Multiple source directories

Compile manifests from multiple directories by running separate `compile` invocations and merging, or by placing all manifests under a single root:

```bash
npx @smallchat/core compile -s ./tools -o tools.json
```

## Output format

The artifact follows format 1.0, defined by the JSON Schema in
[`spec/artifact/artifact.v1.schema.json`](https://github.com/johnnyclem/smallchat/blob/main/spec/artifact/artifact.v1.schema.json):

- **`formatVersion`** — `"1.0"`; loaders refuse anything else (pre-1.0
  artifacts must be recompiled)
- **`embedder`** — fingerprint of the embedder that produced every vector
- **`providers`** — per provider: name, transport, and launch spec (stdio
  command/args and environment variable *names*, never values; or a URL)
- **`tools`** — keyed by canonical id `<providerId>/<toolName>`: upstream
  name, description, `inputSchema`, `outputSchema`, `annotations`, and the
  tool's primary selector
- **`selectors`** — one embedding per selector, each pointing at exactly one tool
- **`collisions`**, **`duplicates`**, **`stats`**
- **`contentHash`** — SHA-256 over the canonical (RFC 8785) JSON of the rest

```json
{
  "formatVersion": "1.0",
  "embedder": { "kind": "onnx", "model": "all-MiniLM-L6-v2", "modelSha256": "afdb6f1a…", "dims": 384, "maxLength": 128, "pooling": "mean", "normalize": true },
  "providers": { "github": { "id": "github", "name": "GitHub", "transportType": "mcp", "launch": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": ["GITHUB_TOKEN"] } } },
  "tools": { "github/search_code": { "id": "github/search_code", "providerId": "github", "name": "search_code", "description": "Search for code across repositories", "inputSchema": { "type": "object" }, "transportType": "mcp", "selector": "github.search_code" } },
  "selectors": { "github.search_code": { "canonical": "github.search_code", "toolId": "github/search_code", "kind": "tool", "vector": [0.12, -0.04] } },
  "collisions": [],
  "duplicates": [],
  "stats": { "toolCount": 1, "selectorCount": 1, "providerCount": 1, "collisionCount": 0, "duplicateCount": 0 },
  "contentHash": "…"
}
```

## Collision warnings

Distinct tools whose selectors are 0.75–0.95 similar are reported as
collision warnings (dispatches between them get MEDIUM-confidence
verification). Both tools stay separate; nothing is merged.

## Near-duplicate tools

The compiler never merges distinct tools: every tool keeps its own selector
and its own canonical id (`<providerId>/<toolName>`). When two distinct
tools embed at cosine similarity ≥ 0.95 (default), intents cannot tell them
apart, so compilation fails and lists each pair:

```
Error: 1 pair(s) of distinct tools embed at cosine >= 0.95 and cannot be told apart:
  github/list_issues <-> github/list-issues (cosine 1.000; …)
```

Disambiguate with compiler hints (`selectorHint`, `aliases`, `exclude`), or
pass `--allow-duplicates` (or `"compiler": { "allowDuplicates": true }` in
`smallchat.json`) to keep every tool and record the pairs in the artifact.
The threshold is `compiler.duplicateThreshold` in `smallchat.json`.
`pinSelector` is taken literally; two tools pinned to the same selector is
always an error.

## Embedder

`--embedder onnx` (default) or `--embedder hash` (a dependency-free
placeholder for development and tests; `local` is its 0.x name). The
artifact records the embedder's fingerprint (model, model SHA-256, dims,
max length, pooling, normalization), and `serve`, `resolve`, `repl` and
`loadRuntime()` construct exactly that embedder or refuse to load. If the
ONNX model cannot be loaded, `compile` fails instead of silently falling
back.

See [ToolCompiler API](../api/compiler) for programmatic configuration.
